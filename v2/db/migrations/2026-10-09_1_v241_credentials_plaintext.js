#!/usr/bin/env node
/*
 * v2.4.1 보안 마이그레이션 — 이력(EUL) 평문 비밀번호 제거 (DDL 없음, 멱등, 단일 트랜잭션)
 *
 * ① EUL credentials_snapshot에만 있고 asset_credentials에 없는 비밀번호를
 *    asset_credentials에 암호화 저장(credentialCrypto 재사용). 같은 (asset,유형,계정)이 이미 있으면 덮어쓰지 않고 보고만.
 * ② 모든 EUL credentials_snapshot에서 password/value 키 제거(username + has_password만).
 *
 * 환경: v2/.env를 dotenv로 로드(운영 CREDENTIAL_ENCRYPTION_KEY·POSTGRES_* 사용). DB 기본 127.0.0.1:5433(앱 config와 동일).
 * 실행(운영=systemd 호스트):
 *   cd /mlcommons_cm/hpc_it_management/v2
 *   NODE_PATH=/mlcommons_cm/hpc_it_management/v2/app/node_modules \
 *     /mlcommons_cm/hpc_it_management/node-v18.20.5-linux-x64/bin/node \
 *     db/migrations/2026-10-09_1_v241_credentials_plaintext.js [--dry-run]
 *   --dry-run: 쓰기 없이 대상만 집계 + 운영 키 암호화→복호화 왕복 일치 검사(값 미출력). BEGIN 후 ROLLBACK.
 * 멱등: 재실행 시 ①은 이미 이전된 건 건너뜀, ②는 이미 제거된 행 건너뜀(변경 0).
 */
'use strict';
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const { Pool } = require('pg');
// credentialCrypto: 호스트(상대경로) / 컨테이너(/app) 양쪽 지원
let credCrypto;
try { credCrypto = require(path.resolve(__dirname, '../../app/utils/credentialCrypto')); }
catch (e) { credCrypto = require('./utils/credentialCrypto'); }

const DRY = process.argv.includes('--dry-run') || process.env.DRY_RUN === '1';
const pool = new Pool({
  host: process.env.PGHOST || '127.0.0.1',
  port: parseInt(process.env.PGPORT || '5433', 10),
  user: process.env.POSTGRES_USER || 'itadmin',
  password: process.env.POSTGRES_PASSWORD || '',
  database: process.env.POSTGRES_DB || 'it_assets'
});

// 이력 전용(= asset_credentials에 비번 없음) 비밀번호 대상
const Q_EUL_ONLY = `
  WITH eul AS (
    SELECT DISTINCT e.asset_id,
           x->>'type' AS ctype,
           COALESCE(NULLIF(x->>'username',''), split_part(COALESCE(x->>'value',''),'/',1), 'root') AS uname,
           COALESCE(NULLIF(x->>'password',''), NULLIF(split_part(COALESCE(x->>'value',''),'/',2),'')) AS pwd
    FROM equipment_usage_logs e, jsonb_array_elements(COALESCE(e.credentials_snapshot,'[]'::jsonb)) x
    WHERE e.asset_id IS NOT NULL
      AND COALESCE(NULLIF(x->>'password',''), NULLIF(split_part(COALESCE(x->>'value',''),'/',2),'')) IS NOT NULL
  )
  SELECT eul.asset_id, eul.ctype, eul.uname, eul.pwd,
         (SELECT COUNT(*) FROM asset_credentials ac
          WHERE ac.asset_id=eul.asset_id AND ac.credential_type=eul.ctype AND ac.username=eul.uname
            AND COALESCE(ac.password_enc, ac.password) IS NOT NULL) AS has_in_cred
  FROM eul ORDER BY eul.asset_id, eul.ctype`;

const Q_SNAP_IDS = `
  SELECT id FROM equipment_usage_logs e
  WHERE e.credentials_snapshot IS NOT NULL
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(e.credentials_snapshot) y WHERE (y ? 'password') OR (y ? 'value'))
  ORDER BY id`;

async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const eul = (await client.query(Q_EUL_ONLY)).rows;
    const transfer = eul.filter(r => Number(r.has_in_cred) === 0);  // 이전 대상(이력 전용)
    const snapIds = (await client.query(Q_SNAP_IDS)).rows.map(r => r.id);

    if (DRY) {
      console.log('=== DRY-RUN (쓰기 없음, ROLLBACK) ===');
      console.log(`① 이전 대상(이력 전용 비번): ${transfer.length}건`);
      for (const r of transfer) {
        let ok = false;
        try { ok = credCrypto.decrypt(credCrypto.encrypt(r.pwd)) === r.pwd; } catch (e) { ok = false; }
        console.log(`   - asset ${r.asset_id} ${r.ctype}/${r.uname} : 운영키 암호화→복호화 왕복 ${ok ? '일치(OK)' : '불일치(FAIL)'}`);
      }
      console.log(`① 이미 asset_credentials 존재(건너뜀): ${eul.length - transfer.length}건`);
      console.log(`② snapshot 평문 제거 대상 EUL: ${snapIds.length}행 — id=[${snapIds.join(',')}]`);
      await client.query('ROLLBACK');
      return;
    }

    // ── 실제 적용 ──
    const moved = [], skipped = [];
    for (const r of eul) {
      if (Number(r.has_in_cred) > 0) { skipped.push(r); continue; }
      const { rows: exist } = await client.query(
        `SELECT id, COALESCE(password_enc,password) AS pw FROM asset_credentials
         WHERE asset_id=$1 AND credential_type=$2 AND username=$3 ORDER BY id LIMIT 1`,
        [r.asset_id, r.ctype, r.uname]);
      if (exist[0] && !exist[0].pw) {
        await client.query('UPDATE asset_credentials SET password_enc=$1, password=NULL WHERE id=$2',
          [credCrypto.encrypt(r.pwd), exist[0].id]);
        moved.push({ ...r, action: 'updated' });
      } else if (!exist[0]) {
        await client.query(
          `INSERT INTO asset_credentials (asset_id, username, password_enc, credential_type, description)
           VALUES ($1,$2,$3,$4,$5)`,
          [r.asset_id, r.uname, credCrypto.encrypt(r.pwd), r.ctype, 'v2.4.1 이력에서 이전']);
        moved.push({ ...r, action: 'inserted' });
      }
    }
    const upd = await client.query(`
      UPDATE equipment_usage_logs e
      SET credentials_snapshot = (
        SELECT jsonb_agg(jsonb_build_object(
          'type', x->>'type',
          'username', COALESCE(NULLIF(x->>'username',''), split_part(COALESCE(x->>'value',''),'/',1)),
          'has_password', (COALESCE(x->>'password','')<>'' OR NULLIF(split_part(COALESCE(x->>'value',''),'/',2),'') IS NOT NULL OR (x->>'has_password')::boolean IS TRUE)
        ))
        FROM jsonb_array_elements(e.credentials_snapshot) x)
      WHERE e.credentials_snapshot IS NOT NULL
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(e.credentials_snapshot) y WHERE (y ? 'password') OR (y ? 'value'))`);
    await client.query('COMMIT');
    console.log('── v2.4.1 자격증명 평문 마이그레이션 완료 ──');
    console.log(`① asset_credentials 이전: moved=${moved.length}, skipped(기존존재)=${skipped.length}`);
    moved.forEach(m => console.log(`   + asset ${m.asset_id} ${m.ctype}/${m.uname} → ${m.action}(암호화)`));
    console.log(`② EUL snapshot password 제거: ${upd.rowCount}행(재실행 시 0)`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('실패(롤백):', err.message); process.exitCode = 1;
  } finally {
    client.release(); await pool.end();
  }
}
main();
