#!/usr/bin/env node
/**
 * Admin 초기 계정 생성/재설정 스크립트
 *
 * 사용법:
 *   node init-admin.js           # admin 없으면 생성, 있으면 skip
 *   node init-admin.js --reset   # admin 비밀번호 강제 재설정
 *
 * 환경변수:
 *   ADMIN_PASSWORD  — admin 비밀번호 (기본 'qwe123')
 *   POSTGRES_DB, POSTGRES_USER, POSTGRES_PASSWORD — DB 접속 (.env에서 로드)
 *
 * 해시 스킴: v1 app/models/user.js와 100% 동일
 *   crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512')
 *   저장: "salt_hex:hash_hex" (161자)
 */

const crypto = require('crypto');
const { Pool } = require('pg');
require('dotenv').config({ path: '../.env' });

// ── 해시 (v1 호환) ──

const SALT_LENGTH = 16;
const ITERATIONS = 100000;
const KEY_LENGTH = 64;
const DIGEST = 'sha512';

function hashPassword(password) {
  const salt = crypto.randomBytes(SALT_LENGTH).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, ITERATIONS, KEY_LENGTH, DIGEST).toString('hex');
  return salt + ':' + hash;
}

// ── 메인 ──

async function main() {
  const args = process.argv.slice(2);
  const reset = args.includes('--reset');
  const password = process.env.ADMIN_PASSWORD || 'qwe123';

  const pool = new Pool({
    host: '127.0.0.1',
    port: 5433,
    database: process.env.POSTGRES_DB,
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
  });

  const client = await pool.connect();

  try {
    // admin 존재 확인
    const existing = await client.query(
      "SELECT id, username, role FROM users WHERE username='admin'"
    );

    if (existing.rows.length === 0) {
      // INSERT
      const passwordHash = hashPassword(password);
      const result = await client.query(
        `INSERT INTO users (username, password_hash, role, display_name)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        ['admin', passwordHash, 'admin', '관리자']
      );
      console.log(`admin 생성됨 (id=${result.rows[0].id})`);

    } else if (!reset) {
      // 존재 + --reset 없음 → skip
      const row = existing.rows[0];
      console.log(`admin 이미 존재 (id=${row.id}). --reset 없이는 변경 안 함.`);

    } else {
      // 존재 + --reset → UPDATE
      const row = existing.rows[0];
      const passwordHash = hashPassword(password);
      await client.query(
        "UPDATE users SET password_hash=$1 WHERE username='admin'",
        [passwordHash]
      );
      console.log(`admin 비밀번호 재설정됨 (id=${row.id}).`);
    }

    // 검증 출력
    const verify = await client.query(
      `SELECT id, username, role, left(password_hash, 16) AS hash_head,
              length(password_hash) AS len
       FROM users WHERE username='admin'`
    );
    if (verify.rows.length > 0) {
      const v = verify.rows[0];
      console.log(`검증: id=${v.id} username=${v.username} role=${v.role} hash_head=${v.hash_head}... len=${v.len}`);
      if (parseInt(v.len) !== 161) {
        console.error(`⚠️ password_hash 길이 ${v.len} (기대 161)`);
      }
    }

  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(e => {
  console.error('에러:', e.message);
  process.exit(1);
});
