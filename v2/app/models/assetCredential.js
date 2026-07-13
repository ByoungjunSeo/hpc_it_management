const { pool } = require('../config/database');
const { fixRowDates } = require('../utils/dateFix');
const credCrypto = require('../utils/credentialCrypto');

// B-4d-9 Date 직렬화 스윕
function fixDates(row) {
  return fixRowDates(row, [], ['created_at']);
}

// BL-11: 저장 행 → 소비용 행. password_enc(암호문) 복호화해 password 필드로 되돌리고,
// password_enc는 노출하지 않도록 제거. 레거시 평문 password 잔존분도 그대로 통과(decrypt가 처리).
function decryptRow(row) {
  const out = fixDates(row);
  out.password = credCrypto.decrypt(row.password_enc || row.password || '');
  delete out.password_enc;
  return out;
}

const AssetCredential = {
  async findByAsset(assetId) {
    const { rows } = await pool.query(
      'SELECT * FROM asset_credentials WHERE asset_id = $1 ORDER BY credential_type, id', [assetId]
    );
    return rows.map(decryptRow);
  },

  async bulkCreate(assetId, creds) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const c of creds) {
        if (c.username && c.username.trim()) {
          // BL-11: 암호문을 password_enc에 저장. 평문 password 컬럼은 미사용(NULL).
          const enc = c.password ? credCrypto.encrypt(c.password) : null;
          await client.query(
            `INSERT INTO asset_credentials (asset_id, username, password_enc, credential_type, description)
             VALUES ($1, $2, $3, $4, $5)`,
            [assetId, c.username.trim(), enc,
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
