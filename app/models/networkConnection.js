const { getDb } = require('../config/database');

const NetworkConnection = {
  findByRoom(roomId) {
    return getDb().prepare(`
      SELECT nc.*,
        fa.asset_number as from_asset_number, fa.model_name as from_model, fa.asset_type as from_type,
        ta.asset_number as to_asset_number, ta.model_name as to_model, ta.asset_type as to_type,
        v.vendor_name
      FROM network_connections nc
      JOIN assets fa ON nc.from_asset_id = fa.id
      JOIN assets ta ON nc.to_asset_id = ta.id
      LEFT JOIN vendor_info v ON nc.vendor_id = v.id
      WHERE nc.room_id = ?
      ORDER BY fa.asset_number, nc.from_port
    `).all(roomId);
  },

  findById(id) {
    return getDb().prepare(`
      SELECT nc.*,
        fa.asset_number as from_asset_number, fa.model_name as from_model, fa.asset_type as from_type,
        ta.asset_number as to_asset_number, ta.model_name as to_model, ta.asset_type as to_type,
        v.vendor_name
      FROM network_connections nc
      JOIN assets fa ON nc.from_asset_id = fa.id
      JOIN assets ta ON nc.to_asset_id = ta.id
      LEFT JOIN vendor_info v ON nc.vendor_id = v.id
      WHERE nc.id = ?
    `).get(id);
  },

  findByAsset(assetId) {
    return getDb().prepare(`
      SELECT nc.*,
        fa.asset_number as from_asset_number, fa.model_name as from_model, fa.asset_type as from_type,
        ta.asset_number as to_asset_number, ta.model_name as to_model, ta.asset_type as to_type,
        v.vendor_name
      FROM network_connections nc
      JOIN assets fa ON nc.from_asset_id = fa.id
      JOIN assets ta ON nc.to_asset_id = ta.id
      LEFT JOIN vendor_info v ON nc.vendor_id = v.id
      WHERE nc.from_asset_id = ? OR nc.to_asset_id = ?
      ORDER BY nc.from_port
    `).all(assetId, assetId);
  },

  create(data) {
    const stmt = getDb().prepare(`
      INSERT INTO network_connections (room_id, from_asset_id, from_port, to_asset_id, to_port, cable_type, cable_label, cable_color, cable_length, ownership, vendor_id, speed, status, description)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      data.room_id,
      data.from_asset_id,
      data.from_port,
      data.to_asset_id,
      data.to_port,
      data.cable_type || null,
      data.cable_label || null,
      data.cable_color || null,
      data.cable_length || null,
      data.ownership || 'company',
      data.vendor_id || null,
      data.speed || null,
      data.status || 'active',
      data.description || null
    );
    return result.lastInsertRowid;
  },

  update(id, data) {
    const stmt = getDb().prepare(`
      UPDATE network_connections SET
        from_asset_id=?, from_port=?, to_asset_id=?, to_port=?,
        cable_type=?, cable_label=?, cable_color=?, cable_length=?,
        ownership=?, vendor_id=?, speed=?, status=?, description=?,
        updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `);
    return stmt.run(
      data.from_asset_id,
      data.from_port,
      data.to_asset_id,
      data.to_port,
      data.cable_type || null,
      data.cable_label || null,
      data.cable_color || null,
      data.cable_length || null,
      data.ownership || 'company',
      data.vendor_id || null,
      data.speed || null,
      data.status || 'active',
      data.description || null,
      id
    );
  },

  moveToSwitch(id, oldSwitchId, newSwitchId) {
    const conn = getDb().prepare('SELECT * FROM network_connections WHERE id = ?').get(id);
    if (!conn) return;
    if (conn.from_asset_id == oldSwitchId) {
      getDb().prepare('UPDATE network_connections SET from_asset_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
        .run(newSwitchId, id);
    } else if (conn.to_asset_id == oldSwitchId) {
      getDb().prepare('UPDATE network_connections SET to_asset_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
        .run(newSwitchId, id);
    }
  },

  delete(id) {
    return getDb().prepare('DELETE FROM network_connections WHERE id = ?').run(id);
  },

  getStats(roomId) {
    return getDb().prepare(`
      SELECT
        COUNT(*) as total_connections,
        SUM(CASE WHEN ownership = 'company' THEN 1 ELSE 0 END) as company_cables,
        SUM(CASE WHEN ownership = 'vendor' THEN 1 ELSE 0 END) as vendor_cables,
        (SELECT COUNT(DISTINCT a.id) FROM assets a
         LEFT JOIN racks r ON a.rack_id = r.id
         WHERE a.asset_type = 'switch' AND (a.room_id = ? OR r.room_id = ?)) as switch_count
      FROM network_connections
      WHERE room_id = ?
    `).get(roomId, roomId, roomId);
  }
};

module.exports = NetworkConnection;
