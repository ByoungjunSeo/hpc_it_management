const { pool } = require('../config/database');
const { fixRowDates } = require('../utils/dateFix');

function fixDates(row) {
  return fixRowDates(row, ['loan_date', 'return_date'],
    ['loan_date', 'return_date', 'created_at']);
}

const Lending = {
  async findAll(filters = {}) {
    let sql = `
      SELECT l.*,
        STRING_AGG(li.item_type || ':' || COALESCE(li.item_code,'') || ' x' || li.quantity, ', ') as items_summary
      FROM lendings l
      LEFT JOIN lending_items li ON li.lending_id = l.id
      WHERE 1=1
    `;
    const params = [];
    let idx = 1;

    if (filters.direction) {
      sql += ' AND l.direction = $' + idx++;
      params.push(filters.direction);
    }
    if (filters.status) {
      sql += ' AND l.status = $' + idx++;
      params.push(filters.status);
    }
    if (filters.search) {
      sql += ' AND (l.counterparty ILIKE $' + idx + ' OR l.notes ILIKE $' + (idx + 1) + ')';
      const s = '%' + filters.search + '%';
      params.push(s, s);
      idx += 2;
    }

    sql += ' GROUP BY l.id ORDER BY l.created_at DESC';
    const { rows } = await pool.query(sql, params);
    rows.forEach(fixDates);
    return rows;
  },

  async findById(id) {
    const { rows } = await pool.query('SELECT * FROM lendings WHERE id = $1', [id]);
    const lending = fixDates(rows[0]);
    if (!lending) return null;
    const items = await pool.query(
      'SELECT * FROM lending_items WHERE lending_id = $1 ORDER BY id', [id]
    );
    lending.items = items.rows;
    return lending;
  },

  async create(data, items) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `INSERT INTO lendings (direction, counterparty, loan_date, return_date, status, notes)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [data.direction, data.counterparty,
         data.loan_date || null, data.return_date || null,
         data.status || 'active', data.notes || null]
      );
      const lendingId = rows[0].id;

      if (items && items.length > 0) {
        for (const item of items) {
          if (item.item_type) {
            await client.query(
              `INSERT INTO lending_items (lending_id, item_type, item_code, quantity, description)
               VALUES ($1, $2, $3, $4, $5)`,
              [lendingId, item.item_type, item.item_code || null,
               item.quantity || 1, item.description || null]
            );
          }
        }
      }
      await client.query('COMMIT');
      return lendingId;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  async update(id, data, items) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE lendings SET direction=$1, counterparty=$2, loan_date=$3, return_date=$4,
          status=$5, notes=$6
         WHERE id=$7`,
        [data.direction, data.counterparty,
         data.loan_date || null, data.return_date || null,
         data.status || 'active', data.notes || null, id]
      );
      await client.query('DELETE FROM lending_items WHERE lending_id = $1', [id]);
      if (items && items.length > 0) {
        for (const item of items) {
          if (item.item_type) {
            await client.query(
              `INSERT INTO lending_items (lending_id, item_type, item_code, quantity, description)
               VALUES ($1, $2, $3, $4, $5)`,
              [id, item.item_type, item.item_code || null,
               item.quantity || 1, item.description || null]
            );
          }
        }
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  async delete(id) {
    // lending_items FK ON DELETE CASCADE → lending만 삭제하면 items 자동 삭제
    return pool.query('DELETE FROM lendings WHERE id = $1', [id]);
  },

  async markReturned(id) {
    return pool.query(
      `UPDATE lendings SET status='returned', return_date=CURRENT_DATE WHERE id=$1`,
      [id]
    );
  },

  // B-4d-8a: 장애반납 — 기존 notes 앞에 [장애반납] 사유 병합(비고 보존, BUG-1 계열 패턴)
  async markFaultReturned(id, { reason, expected_return_date, fault_notes }) {
    const { rows } = await pool.query('SELECT notes FROM lendings WHERE id = $1', [id]);
    const lending = rows[0];
    const existingNotes = lending && lending.notes ? '\n' + lending.notes : '';
    const newNotes = `[장애반납] 사유: ${reason || '장애'}, 예상회수: ${expected_return_date || '미정'}${fault_notes ? '\n' + fault_notes : ''}${existingNotes}`;
    return pool.query(
      `UPDATE lendings SET status='returned', return_date=CURRENT_DATE, notes=$1 WHERE id=$2`,
      [newNotes, id]
    );
  },

  async getStats() {
    const { rows } = await pool.query(`
      SELECT direction, status, COUNT(*) as count
      FROM lendings GROUP BY direction, status
    `);
    return rows;
  }
};

module.exports = Lending;
