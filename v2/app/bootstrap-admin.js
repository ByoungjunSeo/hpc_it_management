#!/usr/bin/env node
/**
 * 컨테이너 첫 기동용 admin 자동 시드 (B-5b)
 *
 * docker-entrypoint.sh가 server.js 전에 실행. 멱등:
 *   - admin 이미 존재 → skip (exit 0)
 *   - 없음 + INITIAL_ADMIN_PASSWORD 설정 → 생성
 *   - 없음 + 미설정 → 명확한 에러로 기동 중단 (exit 1)
 *
 * DB 접속은 앱과 동일한 config/database.js(PGHOST/PGPORT env) 사용.
 * DB가 아직 준비 전이면 재시도 (compose depends_on healthcheck 보조).
 */

const crypto = require('crypto');
const { pool, closeDb } = require('./config/database');

const SALT_LENGTH = 16;
const ITERATIONS = 100000;
const KEY_LENGTH = 64;
const DIGEST = 'sha512';

function hashPassword(password) {
  const salt = crypto.randomBytes(SALT_LENGTH).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, ITERATIONS, KEY_LENGTH, DIGEST).toString('hex');
  return salt + ':' + hash;
}

async function waitForDb(retries = 15, delayMs = 2000) {
  for (let i = 1; i <= retries; i++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (e) {
      if (i === retries) throw new Error('DB 연결 실패 (' + retries + '회 재시도): ' + e.message);
      console.log(`[bootstrap-admin] DB 대기 중... (${i}/${retries})`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
}

async function main() {
  await waitForDb();

  const { rows } = await pool.query("SELECT id FROM users WHERE username='admin'");
  if (rows.length > 0) {
    console.log('[bootstrap-admin] admin 존재 (id=' + rows[0].id + ') — skip');
    return;
  }

  const password = process.env.INITIAL_ADMIN_PASSWORD;
  if (!password) {
    console.error('[bootstrap-admin] 오류: 최초 기동에는 INITIAL_ADMIN_PASSWORD가 필요합니다.');
    console.error('[bootstrap-admin] .env에 INITIAL_ADMIN_PASSWORD=<강한 비밀번호> 를 추가한 뒤 다시 시작하세요.');
    process.exit(1);
  }

  const result = await pool.query(
    `INSERT INTO users (username, password_hash, role, display_name)
     VALUES ('admin', $1, 'admin', '관리자') RETURNING id`,
    [hashPassword(password)]
  );
  console.log('[bootstrap-admin] admin 생성 완료 (id=' + result.rows[0].id + ')');
}

main()
  .then(() => closeDb())
  .catch(e => {
    console.error('[bootstrap-admin] 실패:', e.message);
    process.exit(1);
  });
