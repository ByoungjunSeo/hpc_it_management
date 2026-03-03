const { getDb } = require('../config/database');

const ComputingModule = {
  findAll(filters = {}) {
    let sql = `
      SELECT cm.*, a.model_name as asset_model, a.asset_number, a.ip_address,
        v.vendor_name as owner_vendor_name
      FROM computing_modules cm
      JOIN assets a ON cm.asset_id = a.id
      LEFT JOIN vendor_info v ON cm.owner_vendor_id = v.id
      WHERE 1=1
    `;
    const params = [];

    if (filters.module_type) {
      sql += ' AND cm.module_type = ?';
      params.push(filters.module_type);
    }
    if (filters.asset_id) {
      sql += ' AND cm.asset_id = ?';
      params.push(filters.asset_id);
    }
    if (filters.search) {
      sql += ' AND (cm.model LIKE ? OR cm.manufacturer LIKE ? OR a.model_name LIKE ?)';
      const s = '%' + filters.search + '%';
      params.push(s, s, s);
    }

    sql += ' ORDER BY cm.asset_id, cm.module_type';
    return getDb().prepare(sql).all(...params);
  },

  findById(id) {
    return getDb().prepare(`
      SELECT cm.*, a.model_name as asset_model, a.asset_number,
        v.vendor_name as owner_vendor_name
      FROM computing_modules cm
      JOIN assets a ON cm.asset_id = a.id
      LEFT JOIN vendor_info v ON cm.owner_vendor_id = v.id
      WHERE cm.id = ?
    `).get(id);
  },

  findByAsset(assetId) {
    return getDb().prepare(`
      SELECT cm.*, v.vendor_name as owner_vendor_name
      FROM computing_modules cm
      LEFT JOIN vendor_info v ON cm.owner_vendor_id = v.id
      WHERE cm.asset_id = ? ORDER BY cm.module_type, cm.id
    `).all(assetId);
  },

  create(data) {
    const stmt = getDb().prepare(`
      INSERT INTO computing_modules (asset_id, module_type, model, manufacturer, capacity, count, specification, slot_info, notes, owner, owner_vendor_id, is_onboard)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      data.asset_id, data.module_type, data.model, data.manufacturer,
      data.capacity, data.count || 1, data.specification, data.slot_info, data.notes,
      data.owner || 'company', data.owner_vendor_id || null, data.is_onboard || 0
    );
    return result.lastInsertRowid;
  },

  update(id, data) {
    const stmt = getDb().prepare(`
      UPDATE computing_modules SET asset_id=?, module_type=?, model=?, manufacturer=?, capacity=?,
        count=?, specification=?, slot_info=?, notes=?, owner=?, owner_vendor_id=?, is_onboard=?, updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `);
    return stmt.run(
      data.asset_id, data.module_type, data.model, data.manufacturer,
      data.capacity, data.count || 1, data.specification, data.slot_info, data.notes,
      data.owner || 'company', data.owner_vendor_id || null, data.is_onboard || 0, id
    );
  },

  delete(id) {
    return getDb().prepare('DELETE FROM computing_modules WHERE id = ?').run(id);
  },

  deleteByAsset(assetId) {
    return getDb().prepare('DELETE FROM computing_modules WHERE asset_id = ?').run(assetId);
  },

  bulkCreate(assetId, modules) {
    const stmt = getDb().prepare(`
      INSERT INTO computing_modules (asset_id, module_type, model, manufacturer, capacity, count, specification, slot_info, notes, owner, owner_vendor_id, is_onboard)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertMany = getDb().transaction((mods) => {
      for (const m of mods) {
        stmt.run(assetId, m.module_type, m.model, m.manufacturer,
          m.capacity, m.count || 1, m.specification, m.slot_info, m.notes,
          m.owner || 'company', m.owner_vendor_id || null, m.is_onboard || 0);
      }
    });
    insertMany(modules);
  }
};

module.exports = ComputingModule;
