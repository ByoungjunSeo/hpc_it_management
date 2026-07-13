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
  // 서버측 소비(discovery SSH 스캔 등) — 복호화 password 포함. 화면/JSON 응답엔 쓰지 말 것.
  async findByAsset(assetId) {
    const { rows } = await pool.query(
      'SELECT * FROM asset_credentials WHERE asset_id = $1 ORDER BY credential_type, id', [assetId]
    );
    return rows.map(decryptRow);
  },

  // BL-11 후속: 화면/JSON 응답용 — password 값 미포함. has_password 플래그 + id([보기]용).
  async findByAssetMasked(assetId) {
    const { rows } = await pool.query(
      `SELECT id, asset_id, username, credential_type, description, created_at,
              (COALESCE(password_enc, password) IS NOT NULL AND COALESCE(password_enc, password) <> '') AS has_password
       FROM asset_credentials WHERE asset_id = $1 ORDER BY credential_type, id`, [assetId]
    );
    return rows.map(fixDates);
  },

  // BL-11 후속: [보기] 전용 — 단일 자격증명 복호화(해당 asset 소속 확인). 없으면 null.
  async revealPassword(credId, assetId) {
    const { rows } = await pool.query(
      'SELECT password, password_enc FROM asset_credentials WHERE id = $1 AND asset_id = $2',
      [credId, assetId]
    );
    if (!rows[0]) return null;
    return credCrypto.decrypt(rows[0].password_enc || rows[0].password || '');
  },

  // BL-11 후속: 수정폼 저장 — id 기반 upsert. password 빈칸이면 기존 password_enc 유지("빈칸=유지").
  // 폼에 없는(id 미포함) 기존 자격증명은 삭제. 신규(id 없음)는 INSERT.
  async syncForAsset(assetId, creds) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const keepIds = [];
      for (const c of creds) {
        if (!c.username || !c.username.trim()) continue;
        const id = c.id ? parseInt(c.id, 10) : null;
        if (id) {
          if (c.password && c.password.length) {
            await client.query(
              'UPDATE asset_credentials SET username=$1, password_enc=$2, password=NULL, credential_type=$3, description=$4 WHERE id=$5 AND asset_id=$6',
              [c.username.trim(), credCrypto.encrypt(c.password), c.credential_type || 'root', c.description || null, id, assetId]);
          } else {
            await client.query(
              'UPDATE asset_credentials SET username=$1, credential_type=$2, description=$3 WHERE id=$4 AND asset_id=$5',
              [c.username.trim(), c.credential_type || 'root', c.description || null, id, assetId]);
          }
          keepIds.push(id);
        } else {
          const enc = c.password ? credCrypto.encrypt(c.password) : null;
          const { rows } = await client.query(
            `INSERT INTO asset_credentials (asset_id, username, password_enc, credential_type, description)
             VALUES ($1, $2, $3, $4, $5) RETURNING id`,
            [assetId, c.username.trim(), enc, c.credential_type || 'root', c.description || null]);
          keepIds.push(rows[0].id);
        }
      }
      if (keepIds.length > 0) {
        await client.query('DELETE FROM asset_credentials WHERE asset_id = $1 AND id <> ALL($2::int[])', [assetId, keepIds]);
      } else {
        await client.query('DELETE FROM asset_credentials WHERE asset_id = $1', [assetId]);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
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
