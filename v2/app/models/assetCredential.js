const { pool } = require('../config/database');

const AssetCredential = {
  async findByAsset(assetId) {
    const { rows } = await pool.query(
      'SELECT * FROM asset_credentials WHERE asset_id = $1 ORDER BY credential_type, id', [assetId]
    );
    return rows;
  }
};

module.exports = AssetCredential;
