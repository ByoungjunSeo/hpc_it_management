const { getDb } = require('../config/database');

const AssetCredential = {
  findByAsset(assetId) {
    return getDb().prepare(`
      SELECT * FROM asset_credentials WHERE asset_id = ? ORDER BY credential_type, id
    `).all(assetId);
  },

  bulkCreate(assetId, credentials) {
    const stmt = getDb().prepare(`
      INSERT INTO asset_credentials (asset_id, username, password, credential_type, description)
      VALUES (?, ?, ?, ?, ?)
    `);
    const insertMany = getDb().transaction((items) => {
      for (const cred of items) {
        if (cred.username && cred.username.trim()) {
          stmt.run(assetId, cred.username.trim(), cred.password || null, cred.credential_type || 'root', cred.description || null);
        }
      }
    });
    insertMany(credentials);
  },

  deleteByAsset(assetId) {
    return getDb().prepare('DELETE FROM asset_credentials WHERE asset_id = ?').run(assetId);
  }
};

module.exports = AssetCredential;
