const { getDb } = require('../config/database');

const InventoryLog = {
  findAll(filters = {}) {
    let sql = `
      SELECT il.*, a.model_name as asset_model
      FROM inventory_logs il
      LEFT JOIN assets a ON il.asset_id = a.id
      WHERE 1=1
    `;
    const params = [];

    if (filters.log_type) {
      sql += ' AND il.log_type = ?';
      params.push(filters.log_type);
    }
    if (filters.date_from) {
      sql += ' AND il.log_date >= ?';
      params.push(filters.date_from);
    }
    if (filters.date_to) {
      sql += ' AND il.log_date <= ?';
      params.push(filters.date_to);
    }
    if (filters.search) {
      sql += ' AND (il.item_name LIKE ? OR il.serial_number LIKE ? OR il.vendor_name LIKE ?)';
      const s = '%' + filters.search + '%';
      params.push(s, s, s);
    }

    sql += ' ORDER BY il.log_date DESC, il.created_at DESC';
    return getDb().prepare(sql).all(...params);
  },

  findById(id) {
    return getDb().prepare(`
      SELECT il.*, a.model_name as asset_model
      FROM inventory_logs il
      LEFT JOIN assets a ON il.asset_id = a.id
      WHERE il.id = ?
    `).get(id);
  },

  getRecent(limit = 10) {
    return getDb().prepare(`
      SELECT il.*, a.model_name as asset_model
      FROM inventory_logs il
      LEFT JOIN assets a ON il.asset_id = a.id
      ORDER BY il.log_date DESC, il.created_at DESC
      LIMIT ?
    `).all(limit);
  },

  create(data) {
    const stmt = getDb().prepare(`
      INSERT INTO inventory_logs (log_type, item_name, item_type, quantity, serial_number,
        vendor_name, handler, register_as_asset, asset_id, purpose, notes, log_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      data.log_type, data.item_name, data.item_type, data.quantity || 1,
      data.serial_number, data.vendor_name, data.handler,
      data.register_as_asset ? 1 : 0, data.asset_id || null,
      data.purpose, data.notes, data.log_date || new Date().toISOString().split('T')[0]
    );
    return result.lastInsertRowid;
  },

  delete(id) {
    return getDb().prepare('DELETE FROM inventory_logs WHERE id = ?').run(id);
  },

  findByAsset(assetId) {
    return getDb().prepare(`
      SELECT il.*, a.model_name as asset_model
      FROM inventory_logs il
      LEFT JOIN assets a ON il.asset_id = a.id
      WHERE il.asset_id = ?
      ORDER BY il.log_date DESC, il.created_at DESC
    `).all(assetId);
  },

  createFromSpecChange(data) {
    return this.create({
      log_type: data.log_type || 'inbound',
      item_name: data.item_name,
      item_type: data.item_type || null,
      quantity: data.quantity || 1,
      serial_number: data.serial_number || null,
      vendor_name: data.vendor_name || null,
      handler: data.handler || 'system',
      register_as_asset: 0,
      asset_id: data.asset_id || null,
      purpose: data.purpose || null,
      notes: data.notes || null,
      log_date: data.log_date || new Date().toISOString().split('T')[0]
    });
  },

  countByType() {
    return getDb().prepare(`
      SELECT log_type, COUNT(*) as count FROM inventory_logs GROUP BY log_type
    `).all();
  }
};

module.exports = InventoryLog;
