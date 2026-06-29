const { pool } = require('../config/database');

const AssetIp = {
  async findByAsset(assetId) {
    const { rows } = await pool.query(
      'SELECT * FROM asset_ips WHERE asset_id = $1 ORDER BY ip_type, id', [assetId]
    );
    return rows;
  }
};

module.exports = AssetIp;
