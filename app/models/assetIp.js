const { getDb } = require('../config/database');

const AssetIp = {
  findByAsset(assetId) {
    return getDb().prepare(`
      SELECT * FROM asset_ips WHERE asset_id = ? ORDER BY ip_type, id
    `).all(assetId);
  },

  bulkCreate(assetId, ips) {
    const stmt = getDb().prepare(`
      INSERT INTO asset_ips (asset_id, ip_address, ip_type, description, interface_type, speed)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const insertMany = getDb().transaction((items) => {
      for (const ip of items) {
        if (ip.ip_address && ip.ip_address.trim()) {
          stmt.run(assetId, ip.ip_address.trim(), ip.ip_type || 'management', ip.description || null, ip.interface_type || null, ip.speed || null);
        }
      }
    });
    insertMany(ips);
  },

  deleteByAsset(assetId) {
    return getDb().prepare('DELETE FROM asset_ips WHERE asset_id = ?').run(assetId);
  }
};

module.exports = AssetIp;
