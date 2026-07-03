const { pool } = require('../config/database');

const AssetIp = {
  async findByAsset(assetId) {
    const { rows } = await pool.query(
      'SELECT * FROM asset_ips WHERE asset_id = $1 ORDER BY ip_type, id', [assetId]
    );
    return rows;
  },

  async bulkCreate(assetId, ips) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const ip of ips) {
        if (ip.ip_address && ip.ip_address.trim()) {
          await client.query(
            `INSERT INTO asset_ips (asset_id, ip_address, ip_type, description, interface_type, speed)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [assetId, ip.ip_address.trim(), ip.ip_type || 'management',
             ip.description || null, ip.interface_type || null, ip.speed || null]
          );
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

  async deleteByAsset(assetId) {
    return pool.query('DELETE FROM asset_ips WHERE asset_id = $1', [assetId]);
  }
};

module.exports = AssetIp;
