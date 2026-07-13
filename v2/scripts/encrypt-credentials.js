#!/usr/bin/env node
// BL-11 마이그레이션 (2/2): 평문 자격증명 → AES-256-GCM 암호문.
// 대상: asset_credentials.password(평문) + assets.ssh_password(레거시 평문).
// 안전장치: 트랜잭션 / 멱등(이미 password_enc 있으면 skip) / 복호화 왕복 검증 후에만 평문 비움.
// 실행 전: pg_dump 백업 + CREDENTIAL_ENCRYPTION_KEY 설정 필수(리포트/릴리스 노트 순서 참조).
//   실행: node scripts/encrypt-credentials.js
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Pool } = require('pg');
const credCrypto = require('../app/utils/credentialCrypto');

const pool = new Pool({
  host: process.env.PGHOST || '127.0.0.1',
  port: parseInt(process.env.PGPORT || '5433', 10),
  database: process.env.POSTGRES_DB || 'it_assets',
  user: process.env.POSTGRES_USER || 'itadmin',
  password: process.env.POSTGRES_PASSWORD || '',
});

async function main() {
  if (!credCrypto.keyConfigured()) {
    console.error('[encrypt-credentials] 오류: CREDENTIAL_ENCRYPTION_KEY 미설정/형식오류. openssl rand -hex 32 로 생성해 .env에 설정하세요.');
    process.exit(1);
  }
  const client = await pool.connect();
  let ac = 0, ssh = 0;
  try {
    await client.query('BEGIN');

    // 1) asset_credentials: 평문 password 있고 password_enc 아직 없는 행
    const { rows: creds } = await client.query(
      "SELECT id, password FROM asset_credentials WHERE password IS NOT NULL AND password <> '' AND password_enc IS NULL");
    for (const c of creds) {
      const enc = credCrypto.encrypt(c.password);
      if (credCrypto.decrypt(enc) !== c.password) throw new Error('왕복 검증 실패 asset_credentials.id=' + c.id);
      await client.query('UPDATE asset_credentials SET password_enc = $1, password = NULL WHERE id = $2', [enc, c.id]);
      ac++;
    }

    // 2) assets.ssh_password(레거시) → asset_credentials 신규 행(credential_type='root')로 이관 + 평문 비움
    const { rows: legacy } = await client.query(
      "SELECT id, ssh_user, ssh_password FROM assets WHERE ssh_password IS NOT NULL AND ssh_password <> ''");
    for (const a of legacy) {
      const enc = credCrypto.encrypt(a.ssh_password);
      if (credCrypto.decrypt(enc) !== a.ssh_password) throw new Error('왕복 검증 실패 assets.id=' + a.id);
      await client.query(
        `INSERT INTO asset_credentials (asset_id, username, password_enc, credential_type, description)
         VALUES ($1, $2, $3, 'root', 'Legacy SSH (BL-11 이관)')`,
        [a.id, a.ssh_user || 'root', enc]);
      await client.query('UPDATE assets SET ssh_password = NULL WHERE id = $1', [a.id]);
      ssh++;
    }

    // 사후 검증: 미암호화 잔존 0 확인
    const { rows: r1 } = await client.query("SELECT count(*)::int n FROM asset_credentials WHERE password IS NOT NULL AND password <> ''");
    const { rows: r2 } = await client.query("SELECT count(*)::int n FROM assets WHERE ssh_password IS NOT NULL AND ssh_password <> ''");
    if (r1[0].n !== 0 || r2[0].n !== 0) throw new Error('미암호화 잔존 감지 — 롤백');

    await client.query('COMMIT');
    console.log(`[encrypt-credentials] 완료: asset_credentials ${ac}건 암호화, assets 레거시 ssh_password ${ssh}건 이관. 미암호화 잔존 0.`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[encrypt-credentials] 실패 — 롤백:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}
main();
