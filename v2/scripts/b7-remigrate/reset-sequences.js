#!/usr/bin/env node
/**
 * B-7c': 전 테이블 시퀀스 리셋 (B-2 때의 동적 SQL 패턴 재사용)
 *
 * id 컬럼이 시퀀스(nextval) 기본값을 갖는 public 테이블 전체를 찾아
 * setval(seq, max(id)+1, false) 로 보정한다. (빈 테이블은 1부터)
 *
 * 사용법: timeout 60 node reset-sequences.js
 */
const path = require('path');
const { Pool } = require('pg');
// [B-7c'] env 파일은 B7_ENV_FILE로 지정, 기본은 드라이런 전용 .env.dryrun (운영 .env 아님)
require('dotenv').config({
  path: process.env.B7_ENV_FILE || path.join(__dirname, '..', '..', '.env.dryrun'),
});

// [B-7c' 가드] 접속 대상 포트가 운영 v2(5433)이면 즉시 중단 — 드라이런 전용 안전장치.
// 컷오버(B-7f) 본실행 시에만 B7F_CUTOVER=1 을 명시적으로 지정해 해제한다.
function assertScratchTarget(port) {
  if (String(port) === '5433' && process.env.B7F_CUTOVER !== '1') {
    console.error(`[가드] 접속 대상 포트 ${port} = 운영 v2. 즉시 중단. (컷오버 본실행만 B7F_CUTOVER=1)`);
    process.exit(1);
  }
  if (process.env.B7F_CUTOVER === '1') {
    console.log(`[가드] B7F_CUTOVER=1 — 운영 대상 본실행 모드 (포트 ${port})`);
  }
}

async function main() {
  const pgPort = parseInt(process.env.PGPORT || '5434', 10);
  assertScratchTarget(pgPort);
  console.log(`[대상] PostgreSQL=${process.env.PGHOST || '127.0.0.1'}:${pgPort}`);
  const pg = new Pool({
    host: process.env.PGHOST || '127.0.0.1',
    port: pgPort,
    database: process.env.POSTGRES_DB,
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
  });

  try {
    const { rows: tables } = await pg.query(`
      SELECT table_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND column_name = 'id'
        AND column_default LIKE 'nextval%'
      ORDER BY table_name
    `);

    console.log(`시퀀스 리셋 대상: ${tables.length}개 테이블\n`);
    for (const { table_name } of tables) {
      // table_name은 information_schema에서 온 값만 사용 (동적 식별자 안전)
      const { rows: [r] } = await pg.query(`
        SELECT setval(
                 pg_get_serial_sequence($1, 'id'),
                 COALESCE((SELECT MAX(id) FROM ${table_name}), 0) + 1,
                 false
               ) AS next_val,
               COALESCE((SELECT MAX(id) FROM ${table_name}), 0) AS max_id
      `, [table_name]);
      console.log(`  [${table_name}] max(id)=${r.max_id} → nextval=${r.next_val}`);
    }
    console.log('\n✅ 시퀀스 리셋 완료');
  } finally {
    await pg.end();
  }
}

main().catch(e => { console.error('에러:', e); process.exit(1); });
