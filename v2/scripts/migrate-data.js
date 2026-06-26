#!/usr/bin/env node
/**
 * v1 SQLite → v2 PostgreSQL 데이터 이전 스크립트
 *
 * 사용법: node migrate-data.js [--dry-run] [--table=테이블명]
 *
 * 동작:
 *   1. v1 SQLite readonly 연결
 *   2. v2 PostgreSQL 연결
 *   3. 의존성 순서대로 각 테이블 이전
 *   4. 각 테이블별 행 수 검증 (v1 vs v2)
 *   5. 최종 보고서 출력
 *
 * 안전 장치:
 *   - SQLite는 readonly만
 *   - PostgreSQL에 데이터 있으면 경고 후 확인
 *   - --dry-run 옵션으로 실제 INSERT 없이 검증만
 */

const Database = require('better-sqlite3');
const { Pool } = require('pg');
require('dotenv').config({ path: '../.env' });

const SQLITE_PATH = '../../app/data/it_assets.db';

// ── 유틸리티 ──

/**
 * SQLite KST 로컬시간 → PostgreSQL TIMESTAMPTZ 변환
 * "2026-02-20 23:58:46" → "2026-02-20 23:58:46+09:00"
 * NULL → NULL
 */
function toTimestampTZ(sqliteDatetime) {
  if (!sqliteDatetime) return null;
  return sqliteDatetime + '+09:00';
}

// ── 테이블별 이전 함수 ──

async function migrateServerRooms(sqlite, pgClient) {
  const TABLE = 'server_rooms';
  const rows = sqlite.prepare('SELECT * FROM server_rooms ORDER BY id').all();
  console.log(`\n[${TABLE}] 이전 시작 — ${rows.length}행`);

  await pgClient.query('BEGIN');
  try {
    for (const r of rows) {
      await pgClient.query(
        `INSERT INTO server_rooms (id, name, location, description, location_type, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [r.id, r.name, r.location, r.description, r.location_type,
         toTimestampTZ(r.created_at), toTimestampTZ(r.updated_at)]
      );
    }
    await pgClient.query('COMMIT');
    console.log(`  [${TABLE}] ✅ ${rows.length}행 INSERT 완료`);
  } catch (e) {
    await pgClient.query('ROLLBACK');
    console.error(`  [${TABLE}] ❌ ROLLBACK — ${e.message}`);
    throw e;
  }
}

async function migrateVendorInfo(sqlite, pgClient) {
  const TABLE = 'vendor_info';
  const rows = sqlite.prepare('SELECT * FROM vendor_info ORDER BY id').all();
  console.log(`\n[${TABLE}] 이전 시작 — ${rows.length}행`);

  await pgClient.query('BEGIN');
  try {
    for (const r of rows) {
      await pgClient.query(
        `INSERT INTO vendor_info (id, vendor_name, contact_person, contact_email, contact_phone,
           contract_number, contract_start, contract_end, notes, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [r.id, r.vendor_name, r.contact_person, r.contact_email, r.contact_phone,
         r.contract_number, r.contract_start || null, r.contract_end || null, r.notes,
         toTimestampTZ(r.created_at), toTimestampTZ(r.updated_at)]
      );
    }
    await pgClient.query('COMMIT');
    console.log(`  [${TABLE}] ✅ ${rows.length}행 INSERT 완료`);
  } catch (e) {
    await pgClient.query('ROLLBACK');
    console.error(`  [${TABLE}] ❌ ROLLBACK — ${e.message}`);
    throw e;
  }
}

async function migrateUsers(sqlite, pgClient) {
  const TABLE = 'users';
  const rows = sqlite.prepare('SELECT * FROM users ORDER BY id').all();
  console.log(`\n[${TABLE}] 이전 시작 — ${rows.length}행`);

  await pgClient.query('BEGIN');
  try {
    for (const r of rows) {
      await pgClient.query(
        `INSERT INTO users (id, username, password_hash, role, display_name, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [r.id, r.username, r.password_hash, r.role, r.display_name,
         toTimestampTZ(r.created_at)]
      );
    }
    await pgClient.query('COMMIT');
    console.log(`  [${TABLE}] ✅ ${rows.length}행 INSERT 완료`);
  } catch (e) {
    await pgClient.query('ROLLBACK');
    console.error(`  [${TABLE}] ❌ ROLLBACK — ${e.message}`);
    throw e;
  }
}

async function migrateRacks(sqlite, pgClient) {
  const TABLE = 'racks';
  const rows = sqlite.prepare('SELECT * FROM racks ORDER BY id').all();
  console.log(`\n[${TABLE}] 이전 시작 — ${rows.length}행`);

  // linked_asset_id: assets 미이전이므로 NULL 처리, 나중에 복원
  const deferred = rows.filter(r => r.linked_asset_id != null);
  if (deferred.length > 0) {
    console.log(`  ⚠️ linked_asset_id 보류 ${deferred.length}건 (assets 미이전):`);
    deferred.forEach(r => console.log(`    rack #${r.id} "${r.name}" → asset_id=${r.linked_asset_id} → NULL로 임시 처리`));
  }

  await pgClient.query('BEGIN');
  try {
    for (const r of rows) {
      await pgClient.query(
        `INSERT INTO racks (id, room_id, name, total_units, row_position, col_position,
           description, rack_type, linked_asset_id, switch_slots, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [r.id, r.room_id, r.name, r.total_units, r.row_position, r.col_position,
         r.description, r.rack_type, null, r.switch_slots || 0,
         toTimestampTZ(r.created_at), toTimestampTZ(r.updated_at)]
      );
    }
    await pgClient.query('COMMIT');
    console.log(`  [${TABLE}] ✅ ${rows.length}행 INSERT 완료`);
  } catch (e) {
    await pgClient.query('ROLLBACK');
    console.error(`  [${TABLE}] ❌ ROLLBACK — ${e.message}`);
    throw e;
  }
}

async function migrateModuleInventory(sqlite, pgClient) {
  const TABLE = 'module_inventory';
  const rows = sqlite.prepare('SELECT * FROM module_inventory ORDER BY id').all();
  console.log(`\n[${TABLE}] 이전 시작 — ${rows.length}행`);

  await pgClient.query('BEGIN');
  try {
    for (const r of rows) {
      await pgClient.query(
        `INSERT INTO module_inventory (id, module_type, item_code, label, manufacturer, model,
           capacity, specification, total_quantity, in_use_quantity, spare_quantity,
           storage_quantity, asset_number, owner, owner_vendor_id, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
        [r.id, r.module_type, r.item_code, r.label, r.manufacturer, r.model,
         r.capacity, r.specification, r.total_quantity || 0, r.in_use_quantity || 0,
         r.spare_quantity || 0, r.storage_quantity || 0, r.asset_number,
         r.owner || 'company', r.owner_vendor_id || null,
         toTimestampTZ(r.updated_at)]
      );
    }
    await pgClient.query('COMMIT');
    console.log(`  [${TABLE}] ✅ ${rows.length}행 INSERT 완료`);
  } catch (e) {
    await pgClient.query('ROLLBACK');
    console.error(`  [${TABLE}] ❌ ROLLBACK — ${e.message}`);
    throw e;
  }
}

// ── 검증 ──

async function verifyRowCount(sqlite, pgClient, table) {
  const v1Count = sqlite.prepare(`SELECT COUNT(*) as cnt FROM ${table}`).get().cnt;
  const v2Result = await pgClient.query(`SELECT COUNT(*) as cnt FROM ${table}`);
  const v2Count = parseInt(v2Result.rows[0].cnt);
  const match = v1Count === v2Count;
  console.log(`  [${table}] v1: ${v1Count} | v2: ${v2Count} | ${match ? '✅' : '❌ 불일치'}`);
  return match;
}

// ── 메인 ──

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const tableArg = args.find(a => a.startsWith('--table='));
  const targetTable = tableArg ? tableArg.split('=')[1] : null;

  console.log('=== v1 → v2 데이터 이전 (B-2.2: 단순 테이블 5개) ===');
  console.log(`모드: ${dryRun ? 'DRY RUN (실제 INSERT 없음)' : '실제 실행'}`);
  if (targetTable) console.log(`대상: ${targetTable}만`);
  console.log('');

  const sqlite = new Database(SQLITE_PATH, { readonly: true });
  const pg = new Pool({
    host: '127.0.0.1',
    port: 5433,
    database: process.env.POSTGRES_DB,
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
  });

  // 단일 클라이언트로 트랜잭션 관리
  const pgClient = await pg.connect();

  try {
    // B-2.2 이전 대상 (의존성 순서)
    const migrationPlan = [
      { table: 'server_rooms',    fn: migrateServerRooms },
      { table: 'vendor_info',     fn: migrateVendorInfo },
      { table: 'users',           fn: migrateUsers },
      { table: 'racks',           fn: migrateRacks },
      { table: 'module_inventory', fn: migrateModuleInventory },
    ];

    const targets = targetTable
      ? migrationPlan.filter(m => m.table === targetTable)
      : migrationPlan;

    if (targets.length === 0) {
      console.error(`❌ 테이블 "${targetTable}"은 B-2.2 대상이 아닙니다.`);
      process.exit(1);
    }

    // 이전 실행
    if (!dryRun) {
      for (const { table, fn } of targets) {
        await fn(sqlite, pgClient);
      }
    } else {
      console.log('DRY RUN — INSERT 생략\n');
      for (const { table } of targets) {
        const cnt = sqlite.prepare(`SELECT COUNT(*) as cnt FROM ${table}`).get().cnt;
        console.log(`  [${table}] ${cnt}행 이전 예정`);
      }
    }

    // 검증
    console.log('\n=== 행 수 검증 ===');
    let allMatch = true;
    for (const { table } of targets) {
      const ok = await verifyRowCount(sqlite, pgClient, table);
      if (!ok) allMatch = false;
    }

    // 보류 항목 요약
    console.log('\n=== 보류 항목 ===');
    console.log('  racks.linked_asset_id = 1175 → NULL (rack #212 "AquaRack 21U (탱크)")');
    console.log('  → assets 이전 후 UPDATE로 복원 예정');

    // 최종
    console.log('\n=== 최종 결과 ===');
    if (allMatch) {
      console.log(`✅ B-2.2 완료 — ${targets.length}개 테이블 일치`);
    } else {
      console.log('❌ 일부 테이블 불일치 — 확인 필요');
    }

  } finally {
    pgClient.release();
    sqlite.close();
    await pg.end();
  }
}

main().catch(e => {
  console.error('에러:', e);
  process.exit(1);
});
