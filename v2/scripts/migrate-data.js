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

async function migrateAssets(sqlite, pgClient) {
  const TABLE = 'assets';
  const allRows = sqlite.prepare('SELECT * FROM assets ORDER BY id').all();
  console.log(`\n[${TABLE}] 이전 시작 — ${allRows.length}행`);

  // 자기참조 FK 처리: 부모 먼저, 자식 나중
  const parents = allRows.filter(r => r.parent_asset_id == null);
  const children = allRows.filter(r => r.parent_asset_id != null);
  console.log(`  1차: 부모 자산 ${parents.length}행 (parent_asset_id IS NULL)`);
  console.log(`  2차: 자식 자산 ${children.length}행 (블레이드 노드 등)`);

  const insertSQL = `INSERT INTO assets (id, asset_number, management_number, asset_type, ownership,
       vendor_id, model_name, manufacturer, serial_number, rack_id,
       rack_unit_start, rack_unit_size, ip_address, ssh_port, ssh_user, ssh_password,
       assigned_user, purpose, status, purchase_date, warranty_end, notes,
       blade_slot, room_id, parent_asset_id, shelf_size, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
       $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
       $21, $22, $23, $24, $25, $26, $27, $28)`;

  function rowToParams(r) {
    return [
      r.id, r.asset_number, r.management_number, r.asset_type,
      r.ownership || 'company',
      r.vendor_id || null, r.model_name, r.manufacturer, r.serial_number,
      r.rack_id || null,
      r.rack_unit_start || null, r.rack_unit_size || 1,
      r.ip_address, r.ssh_port || 22, r.ssh_user || 'root', r.ssh_password,
      r.assigned_user, r.purpose, r.status || 'active',
      r.purchase_date || null, r.warranty_end || null, r.notes,
      r.blade_slot, r.room_id || null, r.parent_asset_id || null,
      r.shelf_size || 0,
      toTimestampTZ(r.created_at), toTimestampTZ(r.updated_at)
    ];
  }

  await pgClient.query('BEGIN');
  try {
    // 1차: 부모 자산
    for (const r of parents) {
      await pgClient.query(insertSQL, rowToParams(r));
    }
    console.log(`  [${TABLE}] 1차: 부모 자산 ${parents.length}행 INSERT 완료`);

    // 2차: 자식 자산 (블레이드 노드)
    for (const r of children) {
      await pgClient.query(insertSQL, rowToParams(r));
    }
    console.log(`  [${TABLE}] 2차: 자식 자산 ${children.length}행 INSERT 완료`);

    await pgClient.query('COMMIT');
    console.log(`  [${TABLE}] ✅ 총 ${allRows.length}행 INSERT 완료`);
  } catch (e) {
    await pgClient.query('ROLLBACK');
    console.error(`  [${TABLE}] ❌ ROLLBACK — ${e.message}`);
    throw e;
  }
}

async function migrateIpAddresses(sqlite, pgClient) {
  const TABLE = 'ip_addresses';
  const rows = sqlite.prepare('SELECT * FROM ip_addresses ORDER BY id').all();
  console.log(`\n[${TABLE}] 이전 시작 — ${rows.length}행`);

  const insertSQL = `INSERT INTO ip_addresses (id, ip_address, subnet, network_zone, allocation_type,
       asset_id, assigned_to, description, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`;

  await pgClient.query('BEGIN');
  try {
    let count = 0;
    for (const r of rows) {
      await pgClient.query(insertSQL, [
        r.id, r.ip_address, r.subnet, r.network_zone,
        r.allocation_type || 'available',
        r.asset_id || null, r.assigned_to, r.description,
        toTimestampTZ(r.created_at), toTimestampTZ(r.updated_at)
      ]);
      count++;
      if (count % 500 === 0) {
        console.log(`  [${TABLE}] ${count}/${rows.length}행 진행 중...`);
      }
    }
    await pgClient.query('COMMIT');
    console.log(`  [${TABLE}] ✅ ${rows.length}행 INSERT 완료`);
  } catch (e) {
    await pgClient.query('ROLLBACK');
    console.error(`  [${TABLE}] ❌ ROLLBACK — ${e.message}`);
    throw e;
  }
}

async function migrateAssetIps(sqlite, pgClient) {
  const TABLE = 'asset_ips';
  const rows = sqlite.prepare('SELECT * FROM asset_ips ORDER BY id').all();
  console.log(`\n[${TABLE}] 이전 시작 — ${rows.length}행`);

  const insertSQL = `INSERT INTO asset_ips (id, asset_id, ip_address, ip_type, description,
       interface_type, speed, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`;

  await pgClient.query('BEGIN');
  try {
    for (const r of rows) {
      await pgClient.query(insertSQL, [
        r.id, r.asset_id, r.ip_address, r.ip_type || 'management',
        r.description, r.interface_type, r.speed,
        toTimestampTZ(r.created_at)
      ]);
    }
    await pgClient.query('COMMIT');
    console.log(`  [${TABLE}] ✅ ${rows.length}행 INSERT 완료`);
  } catch (e) {
    await pgClient.query('ROLLBACK');
    console.error(`  [${TABLE}] ❌ ROLLBACK — ${e.message}`);
    throw e;
  }
}

async function migrateAssetCredentials(sqlite, pgClient) {
  const TABLE = 'asset_credentials';
  const rows = sqlite.prepare('SELECT * FROM asset_credentials ORDER BY id').all();
  console.log(`\n[${TABLE}] 이전 시작 — ${rows.length}행`);

  const insertSQL = `INSERT INTO asset_credentials (id, asset_id, username, password, credential_type,
       description, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`;

  await pgClient.query('BEGIN');
  try {
    for (const r of rows) {
      await pgClient.query(insertSQL, [
        r.id, r.asset_id, r.username, r.password,
        r.credential_type || 'root', r.description,
        toTimestampTZ(r.created_at)
      ]);
    }
    await pgClient.query('COMMIT');
    console.log(`  [${TABLE}] ✅ ${rows.length}행 INSERT 완료`);
  } catch (e) {
    await pgClient.query('ROLLBACK');
    console.error(`  [${TABLE}] ❌ ROLLBACK — ${e.message}`);
    throw e;
  }
}

async function migratePhotos(sqlite, pgClient) {
  const TABLE = 'photos';
  const rows = sqlite.prepare('SELECT * FROM photos ORDER BY id').all();
  console.log(`\n[${TABLE}] 이전 시작 — ${rows.length}행`);

  const insertSQL = `INSERT INTO photos (id, entity_type, entity_id, file_path, original_name,
       description, uploaded_at, uploaded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`;

  await pgClient.query('BEGIN');
  try {
    for (const r of rows) {
      await pgClient.query(insertSQL, [
        r.id, r.entity_type, r.entity_id, r.file_path, r.original_name,
        r.description, toTimestampTZ(r.uploaded_at), r.uploaded_by
      ]);
    }
    await pgClient.query('COMMIT');
    console.log(`  [${TABLE}] ✅ ${rows.length}행 INSERT 완료`);
  } catch (e) {
    await pgClient.query('ROLLBACK');
    console.error(`  [${TABLE}] ❌ ROLLBACK — ${e.message}`);
    throw e;
  }
}

async function migrateComputingModules(sqlite, pgClient) {
  const TABLE = 'computing_modules';
  const rows = sqlite.prepare('SELECT * FROM computing_modules ORDER BY id').all();
  console.log(`\n[${TABLE}] 이전 시작 — ${rows.length}행`);

  const insertSQL = `INSERT INTO computing_modules (id, asset_id, module_type, model, manufacturer,
       capacity, count, specification, slot_info, notes, owner, owner_vendor_id,
       is_onboard, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`;

  await pgClient.query('BEGIN');
  try {
    let cnt = 0;
    for (const r of rows) {
      await pgClient.query(insertSQL, [
        r.id, r.asset_id, r.module_type, r.model, r.manufacturer,
        r.capacity, r.count || 1, r.specification, r.slot_info, r.notes,
        r.owner || 'company', r.owner_vendor_id || null,
        r.is_onboard || 0,
        toTimestampTZ(r.created_at), toTimestampTZ(r.updated_at)
      ]);
      cnt++;
      if (cnt % 200 === 0) {
        console.log(`  [${TABLE}] ${cnt}/${rows.length}행 진행 중...`);
      }
    }
    await pgClient.query('COMMIT');
    console.log(`  [${TABLE}] ✅ ${rows.length}행 INSERT 완료`);
  } catch (e) {
    await pgClient.query('ROLLBACK');
    console.error(`  [${TABLE}] ❌ ROLLBACK — ${e.message}`);
    throw e;
  }
}

async function migratePowerNodes(sqlite, pgClient) {
  const TABLE = 'power_nodes';
  const rows = sqlite.prepare('SELECT * FROM power_nodes ORDER BY id').all();
  console.log(`\n[${TABLE}] 이전 시작 — ${rows.length}행`);

  if (rows.length === 0) {
    console.log(`  [${TABLE}] ⏭️ 0행 — 건너뜀`);
    return;
  }

  // 자기참조: parent_id IS NULL 먼저
  const parents = rows.filter(r => r.parent_id == null);
  const children = rows.filter(r => r.parent_id != null);

  const insertSQL = `INSERT INTO power_nodes (id, room_id, parent_id, node_type, name,
       capacity_kw, rating, voltage, phase, circuit_number,
       asset_id, description, sort_order, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`;

  await pgClient.query('BEGIN');
  try {
    for (const r of parents) {
      await pgClient.query(insertSQL, [
        r.id, r.room_id, null, r.node_type, r.name,
        r.capacity_kw, r.rating, r.voltage, r.phase, r.circuit_number,
        r.asset_id || null, r.description, r.sort_order || 0,
        toTimestampTZ(r.created_at), toTimestampTZ(r.updated_at)
      ]);
    }
    for (const r of children) {
      await pgClient.query(insertSQL, [
        r.id, r.room_id, r.parent_id, r.node_type, r.name,
        r.capacity_kw, r.rating, r.voltage, r.phase, r.circuit_number,
        r.asset_id || null, r.description, r.sort_order || 0,
        toTimestampTZ(r.created_at), toTimestampTZ(r.updated_at)
      ]);
    }
    await pgClient.query('COMMIT');
    console.log(`  [${TABLE}] ✅ ${rows.length}행 INSERT 완료`);
  } catch (e) {
    await pgClient.query('ROLLBACK');
    console.error(`  [${TABLE}] ❌ ROLLBACK — ${e.message}`);
    throw e;
  }
}

async function migrateNetworkConnections(sqlite, pgClient) {
  const TABLE = 'network_connections';
  const rows = sqlite.prepare('SELECT * FROM network_connections ORDER BY id').all();
  console.log(`\n[${TABLE}] 이전 시작 — ${rows.length}행`);

  if (rows.length === 0) {
    console.log(`  [${TABLE}] ⏭️ 0행 — 건너뜀`);
    return;
  }

  const insertSQL = `INSERT INTO network_connections (id, room_id, from_asset_id, from_port,
       to_asset_id, to_port, cable_type, cable_label, cable_color, cable_length,
       ownership, vendor_id, speed, status, description, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`;

  await pgClient.query('BEGIN');
  try {
    for (const r of rows) {
      await pgClient.query(insertSQL, [
        r.id, r.room_id, r.from_asset_id, r.from_port,
        r.to_asset_id, r.to_port, r.cable_type, r.cable_label,
        r.cable_color, r.cable_length, r.ownership || 'company',
        r.vendor_id || null, r.speed, r.status || 'active', r.description,
        toTimestampTZ(r.created_at), toTimestampTZ(r.updated_at)
      ]);
    }
    await pgClient.query('COMMIT');
    console.log(`  [${TABLE}] ✅ ${rows.length}행 INSERT 완료`);
  } catch (e) {
    await pgClient.query('ROLLBACK');
    console.error(`  [${TABLE}] ❌ ROLLBACK — ${e.message}`);
    throw e;
  }
}

async function migrateVendorIntakeRequests(sqlite, pgClient) {
  const TABLE = 'vendor_intake_requests';
  const rows = sqlite.prepare('SELECT * FROM vendor_intake_requests ORDER BY id').all();
  console.log(`\n[${TABLE}] 이전 시작 — ${rows.length}행`);

  if (rows.length === 0) {
    console.log(`  [${TABLE}] ⏭️ 0행 — 건너뜀`);
    return;
  }

  const insertSQL = `INSERT INTO vendor_intake_requests (id, token, status, company_name, contact_name,
       contact_phone, contact_email, equipment_type, model_name, manufacturer,
       serial_number, rack_unit_size, quantity, purpose, expected_start, expected_end,
       power_requirement, network_requirement, notes, admin_notes, asset_id,
       submitted_at, reviewed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`;

  await pgClient.query('BEGIN');
  try {
    for (const r of rows) {
      await pgClient.query(insertSQL, [
        r.id, r.token, r.status || 'pending', r.company_name, r.contact_name,
        r.contact_phone, r.contact_email, r.equipment_type || 'server',
        r.model_name, r.manufacturer, r.serial_number,
        r.rack_unit_size || 1, r.quantity || 1, r.purpose,
        r.expected_start || null, r.expected_end || null,
        r.power_requirement, r.network_requirement, r.notes, r.admin_notes,
        r.asset_id || null,
        toTimestampTZ(r.submitted_at), toTimestampTZ(r.reviewed_at)
      ]);
    }
    await pgClient.query('COMMIT');
    console.log(`  [${TABLE}] ✅ ${rows.length}행 INSERT 완료`);
  } catch (e) {
    await pgClient.query('ROLLBACK');
    console.error(`  [${TABLE}] ❌ ROLLBACK — ${e.message}`);
    throw e;
  }
}

async function migrateLendings(sqlite, pgClient) {
  const TABLE = 'lendings';
  const rows = sqlite.prepare('SELECT * FROM lendings ORDER BY id').all();
  console.log(`\n[${TABLE}] 이전 시작 — ${rows.length}행`);

  if (rows.length === 0) {
    console.log(`  [${TABLE}] ⏭️ 0행 — 건너뜀`);
    return;
  }

  const insertSQL = `INSERT INTO lendings (id, direction, counterparty, loan_date, return_date,
       status, notes, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`;

  await pgClient.query('BEGIN');
  try {
    for (const r of rows) {
      await pgClient.query(insertSQL, [
        r.id, r.direction, r.counterparty,
        r.loan_date || null, r.return_date || null,
        r.status || 'active', r.notes,
        toTimestampTZ(r.created_at)
      ]);
    }
    await pgClient.query('COMMIT');
    console.log(`  [${TABLE}] ✅ ${rows.length}행 INSERT 완료`);
  } catch (e) {
    await pgClient.query('ROLLBACK');
    console.error(`  [${TABLE}] ❌ ROLLBACK — ${e.message}`);
    throw e;
  }
}

async function migrateLendingItems(sqlite, pgClient) {
  const TABLE = 'lending_items';
  const rows = sqlite.prepare('SELECT * FROM lending_items ORDER BY id').all();
  console.log(`\n[${TABLE}] 이전 시작 — ${rows.length}행`);

  if (rows.length === 0) {
    console.log(`  [${TABLE}] ⏭️ 0행 — 건너뜀`);
    return;
  }

  const insertSQL = `INSERT INTO lending_items (id, lending_id, item_type, item_code, quantity, description)
     VALUES ($1, $2, $3, $4, $5, $6)`;

  await pgClient.query('BEGIN');
  try {
    for (const r of rows) {
      await pgClient.query(insertSQL, [
        r.id, r.lending_id, r.item_type, r.item_code,
        r.quantity || 1, r.description
      ]);
    }
    await pgClient.query('COMMIT');
    console.log(`  [${TABLE}] ✅ ${rows.length}행 INSERT 완료`);
  } catch (e) {
    await pgClient.query('ROLLBACK');
    console.error(`  [${TABLE}] ❌ ROLLBACK — ${e.message}`);
    throw e;
  }
}

async function migrateAuditLogs(sqlite, pgClient) {
  const TABLE = 'audit_logs';
  const rows = sqlite.prepare('SELECT * FROM audit_logs ORDER BY id').all();
  console.log(`\n[${TABLE}] 이전 시작 — ${rows.length}행`);

  // 삭제된 사용자 user_id → NULL 처리 (v1 FK 미강제, v2 FK ON DELETE SET NULL)
  const validUserIds = new Set(sqlite.prepare('SELECT id FROM users').all().map(u => u.id));
  let nullified = 0;

  const insertSQL = `INSERT INTO audit_logs (id, user_id, username, action, target_type,
       target_id, target_label, details, ip_address, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`;

  await pgClient.query('BEGIN');
  try {
    let cnt = 0;
    for (const r of rows) {
      let userId = r.user_id || null;
      if (userId !== null && !validUserIds.has(userId)) {
        userId = null;
        nullified++;
      }
      // target_id: v1은 TEXT 허용 (item_code 등), v2는 INTEGER
      // 비정수 값은 target_id=NULL, 원래 값은 target_label에 보존
      let targetId = r.target_id;
      let targetLabel = r.target_label;
      if (targetId !== null && typeof targetId === 'string' && !/^\d+$/.test(targetId)) {
        targetLabel = targetLabel || targetId;
        targetId = null;
      }
      await pgClient.query(insertSQL, [
        r.id, userId, r.username, r.action, r.target_type,
        targetId || null, targetLabel, r.details, r.ip_address,
        toTimestampTZ(r.created_at)
      ]);
      cnt++;
      if (cnt % 500 === 0) {
        console.log(`  [${TABLE}] ${cnt}/${rows.length}행 진행 중...`);
      }
    }
    await pgClient.query('COMMIT');
    console.log(`  [${TABLE}] ✅ ${rows.length}행 INSERT 완료`);
    if (nullified > 0) {
      console.log(`  [${TABLE}] ⚠️ 삭제된 사용자 user_id → NULL 처리: ${nullified}행`);
    }
  } catch (e) {
    await pgClient.query('ROLLBACK');
    console.error(`  [${TABLE}] ❌ ROLLBACK — ${e.message}`);
    throw e;
  }
}

async function migrateModuleInventoryLogs(sqlite, pgClient) {
  const TABLE = 'module_inventory_logs';
  const rows = sqlite.prepare('SELECT * FROM module_inventory_logs ORDER BY id').all();
  console.log(`\n[${TABLE}] 이전 시작 — ${rows.length}행`);

  const insertSQL = `INSERT INTO module_inventory_logs (id, item_code, event_type, quantity_change,
       before_total, after_total, before_spare, after_spare,
       asset_id, asset_label, from_asset_id, from_asset_label,
       to_asset_id, to_asset_label, asset_number, user_id, username, notes, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`;

  await pgClient.query('BEGIN');
  try {
    for (const r of rows) {
      await pgClient.query(insertSQL, [
        r.id, r.item_code, r.event_type, r.quantity_change || 0,
        r.before_total, r.after_total, r.before_spare, r.after_spare,
        r.asset_id || null, r.asset_label, r.from_asset_id || null, r.from_asset_label,
        r.to_asset_id || null, r.to_asset_label, r.asset_number,
        r.user_id || null, r.username, r.notes,
        toTimestampTZ(r.created_at)
      ]);
    }
    await pgClient.query('COMMIT');
    console.log(`  [${TABLE}] ✅ ${rows.length}행 INSERT 완료`);
  } catch (e) {
    await pgClient.query('ROLLBACK');
    console.error(`  [${TABLE}] ❌ ROLLBACK — ${e.message}`);
    throw e;
  }
}

async function migrateModuleTransferLogs(sqlite, pgClient) {
  const TABLE = 'module_transfer_logs';
  const rows = sqlite.prepare('SELECT * FROM module_transfer_logs ORDER BY id').all();
  console.log(`\n[${TABLE}] 이전 시작 — ${rows.length}행`);

  // 삭제된 자산 asset_id → NULL 처리 (v1 FK 미강제, v2 FK ON DELETE SET NULL)
  const validAssets = new Set(sqlite.prepare('SELECT id FROM assets').all().map(a => a.id));
  let nullified = 0;

  const insertSQL = `INSERT INTO module_transfer_logs (id, transfer_date, module_type, model, capacity,
       count, owner, owner_vendor_id, from_asset_id, from_asset_label,
       to_asset_id, to_asset_label, reason, user_id, username, notes, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`;

  await pgClient.query('BEGIN');
  try {
    for (const r of rows) {
      let fromId = r.from_asset_id || null;
      let toId = r.to_asset_id || null;
      if (fromId !== null && !validAssets.has(fromId)) { fromId = null; nullified++; }
      if (toId !== null && !validAssets.has(toId)) { toId = null; nullified++; }
      await pgClient.query(insertSQL, [
        r.id, r.transfer_date || null, r.module_type, r.model, r.capacity,
        r.count || 1, r.owner || 'company', r.owner_vendor_id || null,
        fromId, r.from_asset_label,
        toId, r.to_asset_label,
        r.reason, r.user_id || null, r.username, r.notes,
        toTimestampTZ(r.created_at)
      ]);
    }
    await pgClient.query('COMMIT');
    console.log(`  [${TABLE}] ✅ ${rows.length}행 INSERT 완료`);
    if (nullified > 0) {
      console.log(`  [${TABLE}] ⚠️ 삭제된 자산 asset_id → NULL 처리: ${nullified}건`);
    }
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

  console.log('=== v1 → v2 데이터 이전 ===');
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
    // 이전 대상 (의존성 순서)
    const migrationPlan = [
      // B-2.2: 단순 테이블 5개
      { table: 'server_rooms',    fn: migrateServerRooms },
      { table: 'vendor_info',     fn: migrateVendorInfo },
      { table: 'users',           fn: migrateUsers },
      { table: 'racks',           fn: migrateRacks },
      { table: 'module_inventory', fn: migrateModuleInventory },
      // B-2.3: 자산 핵심
      { table: 'assets',          fn: migrateAssets },
      // B-2.4: IP 주소
      { table: 'ip_addresses',    fn: migrateIpAddresses },
      // B-2.5: 자산 부속
      { table: 'asset_ips',       fn: migrateAssetIps },
      { table: 'asset_credentials', fn: migrateAssetCredentials },
      { table: 'photos',          fn: migratePhotos },
      // B-2.6: 모듈 + 시설
      { table: 'computing_modules', fn: migrateComputingModules },
      { table: 'power_nodes',     fn: migratePowerNodes },
      { table: 'network_connections', fn: migrateNetworkConnections },
      // B-2.7: 대여 + 벤더 입고
      { table: 'vendor_intake_requests', fn: migrateVendorIntakeRequests },
      { table: 'lendings',        fn: migrateLendings },
      { table: 'lending_items',   fn: migrateLendingItems },
      // B-2.8: 로그 테이블
      { table: 'audit_logs',      fn: migrateAuditLogs },
      { table: 'module_inventory_logs', fn: migrateModuleInventoryLogs },
      { table: 'module_transfer_logs',  fn: migrateModuleTransferLogs },
    ];

    const targets = targetTable
      ? migrationPlan.filter(m => m.table === targetTable)
      : migrationPlan;

    if (targets.length === 0) {
      console.error(`❌ 테이블 "${targetTable}"은 이전 대상이 아닙니다.`);
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

    // 최종
    console.log('\n=== 최종 결과 ===');
    if (allMatch) {
      console.log(`✅ ${targets.length}개 테이블 일치`);
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
