const { getDb } = require('../config/database');

const ModuleInventoryLog = {
  create(data) {
    return getDb().prepare(`
      INSERT INTO module_inventory_logs
        (item_code, event_type, quantity_change,
         before_total, after_total, before_spare, after_spare,
         asset_id, asset_label,
         from_asset_id, from_asset_label, to_asset_id, to_asset_label,
         asset_number, user_id, username, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      data.item_code,
      data.event_type,
      data.quantity_change || 0,
      data.before_total ?? null,
      data.after_total ?? null,
      data.before_spare ?? null,
      data.after_spare ?? null,
      data.asset_id || null,
      data.asset_label || null,
      data.from_asset_id || null,
      data.from_asset_label || null,
      data.to_asset_id || null,
      data.to_asset_label || null,
      data.asset_number || null,
      data.user_id || null,
      data.username || null,
      data.notes || null
    ).lastInsertRowid;
  },

  findByItemCode(code, limit) {
    const l = limit || 100;
    return getDb().prepare(`
      SELECT * FROM module_inventory_logs
      WHERE item_code = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(code, l);
  },

  findByAsset(assetId) {
    return getDb().prepare(`
      SELECT * FROM module_inventory_logs
      WHERE asset_id = ? OR from_asset_id = ? OR to_asset_id = ?
      ORDER BY created_at DESC
    `).all(assetId, assetId, assetId);
  },

  findAll(filters = {}, limit = 200) {
    let sql = 'SELECT * FROM module_inventory_logs WHERE 1=1';
    const params = [];

    if (filters.event_type) {
      sql += ' AND event_type = ?';
      params.push(filters.event_type);
    }
    if (filters.item_code) {
      sql += ' AND item_code = ?';
      params.push(filters.item_code);
    }
    if (filters.date_from) {
      sql += ' AND created_at >= ?';
      params.push(filters.date_from);
    }
    if (filters.date_to) {
      sql += " AND created_at <= ? || ' 23:59:59'";
      params.push(filters.date_to);
    }
    if (filters.search) {
      sql += ' AND (item_code LIKE ? OR asset_label LIKE ? OR notes LIKE ? OR username LIKE ?)';
      const s = '%' + filters.search + '%';
      params.push(s, s, s, s);
    }

    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);

    return getDb().prepare(sql).all(...params);
  },

  countByEventType() {
    const rows = getDb().prepare(`
      SELECT event_type, COUNT(*) as count FROM module_inventory_logs GROUP BY event_type
    `).all();
    const result = { total: 0 };
    rows.forEach(r => {
      result[r.event_type] = r.count;
      result.total += r.count;
    });
    return result;
  },

  getItemCodes() {
    return getDb().prepare(`
      SELECT DISTINCT item_code FROM module_inventory_logs
      WHERE item_code IS NOT NULL AND item_code != ''
      ORDER BY item_code
    `).all().map(r => r.item_code);
  }
};

module.exports = ModuleInventoryLog;
