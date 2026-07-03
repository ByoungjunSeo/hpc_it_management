const { pool } = require('../config/database');

const AssetCredential = {
  async findByAsset(assetId) {
    const { rows } = await pool.query(
      'SELECT * FROM asset_credentials WHERE asset_id = $1 ORDER BY credential_type, id', [assetId]
    );
    return rows;
  },

  async bulkCreate(assetId, creds) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const c of creds) {
        if (c.username && c.username.trim()) {
          await client.query(
            `INSERT INTO asset_credentials (asset_id, username, password, credential_type, description)
             VALUES ($1, $2, $3, $4, $5)`,
            [assetId, c.username.trim(), c.password || '',
             c.credential_type || 'root', c.description || null]
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
    return pool.query('DELETE FROM asset_credentials WHERE asset_id = $1', [assetId]);
  }
};

module.exports = AssetCredential;
