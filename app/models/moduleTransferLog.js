const { getDb } = require('../config/database');

const ModuleTransferLog = {
  create(data) {
    const stmt = getDb().prepare(`
      INSERT INTO module_transfer_logs
        (transfer_date, module_type, model, capacity, count, owner, owner_vendor_id,
         from_asset_id, from_asset_label, to_asset_id, to_asset_label,
         reason, user_id, username, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      data.transfer_date || null,
      data.module_type,
      data.model || null,
      data.capacity || null,
      data.count || 1,
      data.owner || 'company',
      data.owner_vendor_id || null,
      data.from_asset_id || null,
      data.from_asset_label || null,
      data.to_asset_id || null,
      data.to_asset_label || null,
      data.reason || null,
      data.user_id || null,
      data.username || null,
      data.notes || null
    );
    return result.lastInsertRowid;
  },

  bulkCreate(logs) {
    const stmt = getDb().prepare(`
      INSERT INTO module_transfer_logs
        (transfer_date, module_type, model, capacity, count, owner, owner_vendor_id,
         from_asset_id, from_asset_label, to_asset_id, to_asset_label,
         reason, user_id, username, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertMany = getDb().transaction((items) => {
      for (const d of items) {
        stmt.run(
          d.transfer_date || null,
          d.module_type,
          d.model || null,
          d.capacity || null,
          d.count || 1,
          d.owner || 'company',
          d.owner_vendor_id || null,
          d.from_asset_id || null,
          d.from_asset_label || null,
          d.to_asset_id || null,
          d.to_asset_label || null,
          d.reason || null,
          d.user_id || null,
          d.username || null,
          d.notes || null
        );
      }
    });
    insertMany(logs);
  },

  findByAsset(assetId) {
    return getDb().prepare(`
      SELECT mtl.*, v.vendor_name as owner_vendor_name
      FROM module_transfer_logs mtl
      LEFT JOIN vendor_info v ON mtl.owner_vendor_id = v.id
      WHERE mtl.from_asset_id = ? OR mtl.to_asset_id = ?
      ORDER BY mtl.created_at DESC
    `).all(assetId, assetId);
  },

  findAll(filters = {}) {
    let sql = `
      SELECT mtl.*, v.vendor_name as owner_vendor_name
      FROM module_transfer_logs mtl
      LEFT JOIN vendor_info v ON mtl.owner_vendor_id = v.id
      WHERE 1=1
    `;
    const params = [];

    if (filters.asset_id) {
      sql += ' AND (mtl.from_asset_id = ? OR mtl.to_asset_id = ?)';
      params.push(filters.asset_id, filters.asset_id);
    }
    if (filters.from_date) {
      sql += ' AND mtl.transfer_date >= ?';
      params.push(filters.from_date);
    }
    if (filters.to_date) {
      sql += ' AND mtl.transfer_date <= ?';
      params.push(filters.to_date);
    }
    if (filters.module_type) {
      sql += ' AND mtl.module_type = ?';
      params.push(filters.module_type);
    }

    sql += ' ORDER BY mtl.created_at DESC';

    if (filters.limit) {
      sql += ' LIMIT ?';
      params.push(filters.limit);
    }

    return getDb().prepare(sql).all(...params);
  }
};

module.exports = ModuleTransferLog;
