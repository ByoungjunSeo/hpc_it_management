const { getDb } = require('../config/database');

const Lending = {
  findAll(filters = {}) {
    let sql = `
      SELECT l.*,
        GROUP_CONCAT(li.item_type || ':' || COALESCE(li.item_code,'') || ' x' || li.quantity, ', ') as items_summary
      FROM lendings l
      LEFT JOIN lending_items li ON li.lending_id = l.id
      WHERE 1=1
    `;
    const params = [];

    if (filters.direction) {
      sql += ' AND l.direction = ?';
      params.push(filters.direction);
    }
    if (filters.status) {
      sql += ' AND l.status = ?';
      params.push(filters.status);
    }
    if (filters.search) {
      sql += ' AND (l.counterparty LIKE ? OR l.notes LIKE ?)';
      const s = '%' + filters.search + '%';
      params.push(s, s);
    }

    sql += ' GROUP BY l.id ORDER BY l.created_at DESC';
    return getDb().prepare(sql).all(...params);
  },

  findById(id) {
    const lending = getDb().prepare('SELECT * FROM lendings WHERE id = ?').get(id);
    if (!lending) return null;
    lending.items = getDb().prepare('SELECT * FROM lending_items WHERE lending_id = ? ORDER BY id').all(id);
    return lending;
  },

  create(data, items) {
    const db = getDb();
    const insertLending = db.prepare(`
      INSERT INTO lendings (direction, counterparty, loan_date, return_date, status, notes)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const insertItem = db.prepare(`
      INSERT INTO lending_items (lending_id, item_type, item_code, quantity, description)
      VALUES (?, ?, ?, ?, ?)
    `);

    const tx = db.transaction(() => {
      const result = insertLending.run(
        data.direction, data.counterparty,
        data.loan_date || null, data.return_date || null,
        data.status || 'active', data.notes || null
      );
      const lendingId = result.lastInsertRowid;

      if (items && items.length > 0) {
        for (const item of items) {
          if (item.item_type) {
            insertItem.run(lendingId, item.item_type, item.item_code || null,
              item.quantity || 1, item.description || null);
          }
        }
      }
      return lendingId;
    });
    return tx();
  },

  update(id, data, items) {
    const db = getDb();
    const updateLending = db.prepare(`
      UPDATE lendings SET direction=?, counterparty=?, loan_date=?, return_date=?,
        status=?, notes=?
      WHERE id=?
    `);
    const deleteItems = db.prepare('DELETE FROM lending_items WHERE lending_id = ?');
    const insertItem = db.prepare(`
      INSERT INTO lending_items (lending_id, item_type, item_code, quantity, description)
      VALUES (?, ?, ?, ?, ?)
    `);

    const tx = db.transaction(() => {
      updateLending.run(
        data.direction, data.counterparty,
        data.loan_date || null, data.return_date || null,
        data.status || 'active', data.notes || null, id
      );
      deleteItems.run(id);
      if (items && items.length > 0) {
        for (const item of items) {
          if (item.item_type) {
            insertItem.run(id, item.item_type, item.item_code || null,
              item.quantity || 1, item.description || null);
          }
        }
      }
    });
    tx();
  },

  delete(id) {
    return getDb().prepare('DELETE FROM lendings WHERE id = ?').run(id);
  },

  markReturned(id) {
    return getDb().prepare(`
      UPDATE lendings SET status='returned', return_date=date('now') WHERE id=?
    `).run(id);
  },

  markFaultReturned(id, { reason, expected_return_date, fault_notes }) {
    const db = getDb();
    const lending = db.prepare('SELECT notes FROM lendings WHERE id = ?').get(id);
    const existingNotes = lending && lending.notes ? '\n' + lending.notes : '';
    const newNotes = `[장애반납] 사유: ${reason || '장애'}, 예상회수: ${expected_return_date || '미정'}${fault_notes ? '\n' + fault_notes : ''}${existingNotes}`;
    return db.prepare(`
      UPDATE lendings SET status='returned', return_date=date('now'), notes=? WHERE id=?
    `).run(newNotes, id);
  },

  getStats() {
    return getDb().prepare(`
      SELECT direction, status, COUNT(*) as count
      FROM lendings GROUP BY direction, status
    `).all();
  }
};

module.exports = Lending;
