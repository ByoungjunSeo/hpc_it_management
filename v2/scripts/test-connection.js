#!/usr/bin/env node
/**
 * 연결 테스트 스크립트
 *
 * 실행: node test-connection.js
 *
 * 확인:
 *   1. v1 SQLite readonly 연결
 *   2. v2 PostgreSQL 연결
 *   3. 각 DB에서 간단한 쿼리 실행
 */

const Database = require('better-sqlite3');
const { Pool } = require('pg');
require('dotenv').config({ path: '../.env' });

const SQLITE_PATH = '../../app/data/it_assets.db';

async function testConnections() {
  console.log('=== 연결 테스트 시작 ===\n');

  // 1. v1 SQLite
  console.log('[1] v1 SQLite 연결 (readonly)');
  console.log(`    경로: ${SQLITE_PATH}`);
  let sqlite;
  try {
    sqlite = new Database(SQLITE_PATH, { readonly: true, fileMustExist: true });
    const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
    console.log(`    ✅ 연결 성공`);
    console.log(`    테이블 수: ${tables.length}개`);
    const assetCount = sqlite.prepare("SELECT COUNT(*) as cnt FROM assets").get();
    console.log(`    assets 행 수: ${assetCount.cnt}`);
  } catch (e) {
    console.error(`    ❌ 실패: ${e.message}`);
    process.exit(1);
  }

  // 2. v2 PostgreSQL
  console.log('\n[2] v2 PostgreSQL 연결');
  const config = {
    host: '127.0.0.1',
    port: 5433,
    database: process.env.POSTGRES_DB,
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
  };
  console.log(`    host: ${config.host}:${config.port}`);
  console.log(`    database: ${config.database}`);
  console.log(`    user: ${config.user}`);
  console.log(`    password: ${config.password ? '*** (설정됨)' : '❌ 누락'}`);

  if (!config.password) {
    console.error('    ❌ POSTGRES_PASSWORD가 .env에 없습니다');
    process.exit(1);
  }

  const pool = new Pool(config);
  try {
    const result = await pool.query("SELECT COUNT(*) as cnt FROM pg_tables WHERE schemaname='public'");
    console.log(`    ✅ 연결 성공`);
    console.log(`    테이블 수: ${result.rows[0].cnt}개`);

    const assetCount = await pool.query("SELECT COUNT(*) as cnt FROM assets");
    console.log(`    assets 행 수: ${assetCount.rows[0].cnt}`);
  } catch (e) {
    console.error(`    ❌ 실패: ${e.message}`);
    process.exit(1);
  }

  // 3. 정리
  sqlite.close();
  await pool.end();

  console.log('\n=== 모든 연결 테스트 통과 ✅ ===');
  console.log('B-2.2 진행 가능');
}

testConnections().catch(e => {
  console.error('예상 못 한 에러:', e);
  process.exit(1);
});
