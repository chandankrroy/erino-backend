const express = require('express');
const { pool } = require('../db');
const auth = require('../middleware/auth');

const router = express.Router();

// Build WHERE clause supporting required operators
const buildWhereClause = (q) => {
  const conditions = [];
  const values = [];
  let i = 1;

  // Owner scope
  conditions.push(`user_id = $${i++}`);
  values.push(q.userId);

  // String fields: equals / contains
  const stringField = (field) => {
    if (q[`${field}_equals`]) {
      conditions.push(`${field} = $${i}`);
      values.push(q[`${field}_equals`]);
      i++;
    }
    if (q[`${field}_contains`]) {
      conditions.push(`${field} ILIKE $${i}`);
      values.push(`%${q[`${field}_contains`]}%`);
      i++;
    }
  };
  stringField('email');
  stringField('company');
  stringField('city');
  // Also support names for convenience
  stringField('first_name');
  stringField('last_name');

  // Enums: equals / in
  const enumField = (field) => {
    if (q[field]) {
      conditions.push(`${field} = $${i}`);
      values.push(q[field]);
      i++;
    }
    if (q[`${field}_in`]) {
      const list = String(q[`${field}_in`])
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (list.length) {
        const placeholders = list.map(() => `$${i++}`);
        conditions.push(`${field} IN (${placeholders.join(',')})`);
        values.push(...list);
      }
    }
  };
  enumField('status');
  enumField('source');

  // Numbers: equals / gt / lt / between
  const numberField = (field) => {
    if (q[field] !== undefined) {
      conditions.push(`${field} = $${i}`);
      values.push(Number(q[field]));
      i++;
    }
    if (q[`${field}_gt`] !== undefined) {
      conditions.push(`${field} > $${i}`);
      values.push(Number(q[`${field}_gt`]));
      i++;
    }
    if (q[`${field}_lt`] !== undefined) {
      conditions.push(`${field} < $${i}`);
      values.push(Number(q[`${field}_lt`]));
      i++;
    }
    if (q[`${field}_between`]) {
      const [min, max] = String(q[`${field}_between`]).split(',');
      if (min !== undefined && max !== undefined) {
        conditions.push(`${field} BETWEEN $${i} AND $${i + 1}`);
        values.push(Number(min), Number(max));
        i += 2;
      }
    }
  };
  numberField('score');
  numberField('lead_value');

  // Back-compat: value_min/value_max
  if (q.value_min !== undefined) {
    conditions.push(`lead_value >= $${i}`);
    values.push(Number(q.value_min));
    i++;
  }
  if (q.value_max !== undefined) {
    conditions.push(`lead_value <= $${i}`);
    values.push(Number(q.value_max));
    i++;
  }

  // Dates: on / before / after / between
  const dateField = (field) => {
    if (q[`${field}_on`]) {
      conditions.push(`${field}::date = $${i}`);
      values.push(q[`${field}_on`]);
      i++;
    }
    if (q[`${field}_before`]) {
      conditions.push(`${field}::date <= $${i}`);
      values.push(q[`${field}_before`]);
      i++;
    }
    if (q[`${field}_after`]) {
      conditions.push(`${field}::date >= $${i}`);
      values.push(q[`${field}_after`]);
      i++;
    }
    if (q[`${field}_between`]) {
      const [from, to] = String(q[`${field}_between`]).split(',');
      if (from && to) {
        conditions.push(`${field} BETWEEN $${i} AND $${i + 1}`);
        values.push(from, to);
        i += 2;
      }
    }
  };
  dateField('created_at');
  dateField('last_activity_at');

  // Back-compat: created_after/created_before
  if (q.created_after) {
    conditions.push(`created_at::date >= $${i}`);
    values.push(q.created_after);
    i++;
  }
  if (q.created_before) {
    conditions.push(`created_at::date <= $${i}`);
    values.push(q.created_before);
    i++;
  }

  // Boolean
  if (q.is_qualified !== undefined) {
    conditions.push(`is_qualified = $${i}`);
    values.push(String(q.is_qualified).toLowerCase() === 'true');
    i++;
  }

  return { where: conditions.length ? conditions.join(' AND ') : 'TRUE', values };
};

// GET /leads with pagination + filters
router.get('/', auth, async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100);
    const offset = (page - 1) * limit;

    const { where, values } = buildWhereClause({ ...req.query, userId: req.user.id });

    const countQuery = `SELECT COUNT(*) FROM leads WHERE ${where}`;
    const countResult = await pool.query(countQuery, values);
    const total = parseInt(countResult.rows[0].count);

    const listQuery = `
      SELECT *
      FROM leads
      WHERE ${where}
      ORDER BY created_at DESC
      LIMIT $${values.length + 1} OFFSET $${values.length + 2}
    `;
    const listResult = await pool.query(listQuery, [...values, limit, offset]);

    const payload = {
      data: listResult.rows,
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit)
    };
    // Back-compat shape for current frontend
    payload.leads = payload.data;
    payload.pagination = { page, limit, total, pages: payload.totalPages };
    res.json(payload);
  } catch (error) {
    console.error('Get leads error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /leads/:id
router.get('/:id', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const rs = await pool.query(
      'SELECT * FROM leads WHERE id = $1 AND user_id = $2',
      [id, req.user.id]
    );
    if (rs.rows.length === 0) return res.status(404).json({ error: 'Lead not found' });
    res.json({ lead: rs.rows[0] });
  } catch (error) {
    console.error('Get lead error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /leads
router.post('/', auth, async (req, res) => {
  try {
    const {
      first_name,
      last_name,
      email,
      phone,
      company,
      city,
      state,
      source,
      status,
      score,
      lead_value,
      last_activity_at,
      is_qualified
    } = req.body;

    if (!first_name || !last_name || !email) {
      return res.status(400).json({ error: 'first_name, last_name, and email are required' });
    }

    const insert = await pool.query(
      `INSERT INTO leads (
        user_id, first_name, last_name, email, phone, company, city, state,
        source, status, score, lead_value, last_activity_at, is_qualified
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      RETURNING *`,
      [
        req.user.id,
        first_name,
        last_name,
        email,
        phone || null,
        company || null,
        city || null,
        state || null,
        source || null,
        status || 'new',
        typeof score === 'number' ? score : null,
        typeof lead_value === 'number' ? lead_value : null,
        last_activity_at || null,
        typeof is_qualified === 'boolean' ? is_qualified : false
      ]
    );

    res.status(201).json({ message: 'Lead created successfully', lead: insert.rows[0] });
  } catch (error) {
    console.error('Create lead error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /leads/:id
router.put('/:id', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const exists = await pool.query('SELECT id FROM leads WHERE id = $1 AND user_id = $2', [id, req.user.id]);
    if (exists.rows.length === 0) return res.status(404).json({ error: 'Lead not found' });

    const {
      first_name,
      last_name,
      email,
      phone,
      company,
      city,
      state,
      source,
      status,
      score,
      lead_value,
      last_activity_at,
      is_qualified
    } = req.body;

    if (!first_name || !last_name || !email) {
      return res.status(400).json({ error: 'first_name, last_name, and email are required' });
    }

    const update = await pool.query(
      `UPDATE leads SET
        first_name=$1, last_name=$2, email=$3, phone=$4, company=$5, city=$6, state=$7,
        source=$8, status=$9, score=$10, lead_value=$11, last_activity_at=$12,
        is_qualified=$13, updated_at=CURRENT_TIMESTAMP
      WHERE id=$14 AND user_id=$15
      RETURNING *`,
      [
        first_name,
        last_name,
        email,
        phone || null,
        company || null,
        city || null,
        state || null,
        source || null,
        status || 'new',
        typeof score === 'number' ? score : null,
        typeof lead_value === 'number' ? lead_value : null,
        last_activity_at || null,
        typeof is_qualified === 'boolean' ? is_qualified : false,
        id,
        req.user.id
      ]
    );

    res.json({ message: 'Lead updated successfully', lead: update.rows[0] });
  } catch (error) {
    console.error('Update lead error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /leads/:id
router.delete('/:id', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const del = await pool.query('DELETE FROM leads WHERE id = $1 AND user_id = $2 RETURNING id', [id, req.user.id]);
    if (del.rows.length === 0) return res.status(404).json({ error: 'Lead not found' });
    res.json({ message: 'Lead deleted successfully' });
  } catch (error) {
    console.error('Delete lead error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
