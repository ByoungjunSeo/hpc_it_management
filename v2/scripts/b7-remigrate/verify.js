#!/usr/bin/env node
/**
 * B-7c' STEP 5: 재이관 검증 쿼리 세트
 *
 * 대조 기준은 하드코딩이 아니라 v1 스냅샷에서 COUNT를 다시 읽어 비교한다.
 * (B-7a 조사 이후 v1이 더 변했을 수 있으므로. B-7a §2 수치는 참고 기대치로 병기)
 *
 * 검증 항목:
 *   1. 전 테이블 행 수: v1 스냅샷 = 대상 DB
 *   2. EUL: 스냅샷에서 migrate-eul 규칙으로 기대 이벤트 수/분포 산출 → 대조
 *      + returned/estimated 표본 규칙 확인
 *   3. FK 정합(고아 0): asset_ips/asset_credentials/computing_modules/photos/EUL → assets
 *   4. 시퀀스: 전 테이블 nextval > max(id)
 *   5. 랙 삭제 반영: racks = 23 (27이면 실패)
 *   6. 표본 내용 대조: assets 5행, module_inventory 5행 컬럼 단위 diff
 *
 * 사용법: timeout 120 node verify.js
 */
const path = require('path');
const Database = require('better-sqlite3');
const { Pool } = require('pg');
// [B-7c'] env 파일은 B7_ENV_FILE로 지정, 기본은 드라이런 전용 .env.dryrun (운영 .env 아님)
require('dotenv').config({
  path: process.env.B7_ENV_FILE || path.join(__dirname, '..', '..', '.env.dryrun'),
});

const V1_DB = process.env.B7_SQLITE_PATH || '/tmp/v1_snapshot_b7a.sqlite';

// [B-7c' 가드] 검증은 읽기 전용이지만 일관성 위해 동일 가드 적용.
// 컷오버(B-7f) 후 운영 검증 시에만 B7F_CUTOVER=1.
function assertScratchTarget(port) {
  if (String(port) === '5433' && process.env.B7F_CUTOVER !== '1') {
    console.error(`[가드] 접속 대상 포트 ${port} = 운영 v2. 즉시 중단. (컷오버 본실행만 B7F_CUTOVER=1)`);
    process.exit(1);
  }
}

// B-7a §2 참고 기대치 (판정 기준 아님 — 스냅샷 실측이 기준)
const REF_EXPECTED = {
  server_rooms: 9, vendor_info: 16, users: 13, racks: 23, module_inventory: 204,
  assets: 174, ip_addresses: 2304, asset_ips: 221, asset_credentials: 221, photos: 48,
  computing_modules: 569, power_nodes: 0, network_connections: 0,
  vendor_intake_requests: 1, lendings: 1, lending_items: 1,
  module_inventory_logs: 468, module_transfer_logs: 448,
};

// migrate-data.js의 이전 대상 19개 테이블 (의존성 순서)
const MIGRATED_TABLES = [
  'server_rooms', 'vendor_info', 'users', 'racks', 'module_inventory',
  'assets', 'ip_addresses', 'asset_ips', 'asset_credentials', 'photos',
  'computing_modules', 'power_nodes', 'network_connections',
  'vendor_intake_requests', 'lendings', 'lending_items',
  'audit_logs', 'module_inventory_logs', 'module_transfer_logs',
];

// ── migrate-eul.js와 동일한 매핑 규칙 (기대치 산출용) ──
const STATUS_MAP = { '입고': 'incoming', '사용중': 'in_use', '반납완료': 'in_use' };
const isEmpty = (v) => v == null || v === '';
const ESTIMATE_MARKER = '[event_date estimated from created_at]';
const RETURNED_MARKER = '[returned event migrated from return_date]';

function eulExpectedFromSnapshot(sqlite) {
  const rows = sqlite.prepare('SELECT * FROM equipment_usage_logs ORDER BY id').all();
  const dist = {};
  let base = 0, returnedExtra = 0, unmapped = 0;
  for (const r of rows) {
    const t = STATUS_MAP[r.status];
    if (!t) { unmapped++; continue; }
    base++;
    dist[t] = (dist[t] || 0) + 1;
    if (!isEmpty(r.return_date)) {
      returnedExtra++;
      dist.returned = (dist.returned || 0) + 1;
    }
  }
  return { v1Rows: rows.length, base, returnedExtra, unmapped, total: base + returnedExtra, dist, rows };
}

// ── 표본 내용 대조 유틸 ──
function fmtKst(d) {
  // timestamptz Date → 'YYYY-MM-DD HH:MM:SS' (KST)
  return d.toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' });
}
function normalizePg(v, v1Val) {
  if (v == null) return null;
  if (v instanceof Date) {
    // v1 값이 날짜만이면 날짜부만 비교
    if (typeof v1Val === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v1Val)) {
      return v.toLocaleDateString('sv-SE');
    }
    return fmtKst(v);
  }
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}
function normalizeV1(v) {
  return v == null ? null : v;
}

// migrate-data.js의 의도된 NULL→기본값 보정 (예: r.ssh_user || 'root').
// v1이 빈 값이고 v2가 해당 기본값이면 정상 이관으로 판정.
const KNOWN_COERCIONS = {
  assets: { ssh_user: 'root', ssh_port: 22, rack_unit_size: 1, status: 'active' },
};

async function sampleDiff(sqlite, pg, table, results) {
  const ids = sqlite.prepare(`SELECT id FROM ${table} ORDER BY id`).all().map(r => r.id);
  if (ids.length === 0) { results.push([`표본 ${table}`, true, '행 없음 — 생략']); return; }
  // 결정적 표본: 최소/최대 + 3분위 지점
  const pick = [...new Set([0, Math.floor(ids.length * 0.25), Math.floor(ids.length * 0.5),
    Math.floor(ids.length * 0.75), ids.length - 1].map(i => ids[i]))];
  let diffs = 0;
  const detail = [];
  for (const id of pick) {
    const v1r = sqlite.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
    const { rows: [v2r] } = await pg.query(`SELECT * FROM ${table} WHERE id = $1`, [id]);
    if (!v2r) { diffs++; detail.push(`id=${id}: v2에 없음`); continue; }
    const commonCols = Object.keys(v1r).filter(c => c in v2r);
    for (const c of commonCols) {
      const coerce = (KNOWN_COERCIONS[table] || {})[c];
      if (coerce !== undefined && isEmpty(v1r[c]) && String(v2r[c]) === String(coerce)) continue;
      const a = normalizeV1(v1r[c]);
      const b = normalizePg(v2r[c], v1r[c]);
      const aCmp = typeof b === 'string' && typeof a !== 'string' ? String(a) : a;
      if (String(aCmp ?? '') !== String(b ?? '')) {
        // KST 변환 컬럼(created_at 등)은 v1 문자열 그대로와 일치해야 함
        diffs++;
        detail.push(`id=${id} ${c}: v1=${JSON.stringify(v1r[c])} vs v2=${JSON.stringify(v2r[c] instanceof Date ? fmtKst(v2r[c]) : v2r[c])}`);
      }
    }
  }
  results.push([`표본 ${table} (${pick.length}행 컬럼 diff)`, diffs === 0,
    diffs === 0 ? `id=[${pick.join(',')}] 전 컬럼 일치` : `${diffs}건 상이: ${detail.slice(0, 5).join(' | ')}`]);
}

async function main() {
  const pgPort = parseInt(process.env.PGPORT || '5434', 10);
  assertScratchTarget(pgPort);
  console.log(`[검증 대상] 스냅샷=${V1_DB} vs PostgreSQL=${process.env.PGHOST || '127.0.0.1'}:${pgPort}\n`);

  const sqlite = new Database(V1_DB, { readonly: true, fileMustExist: true });
  const pg = new Pool({
    host: process.env.PGHOST || '127.0.0.1',
    port: pgPort,
    database: process.env.POSTGRES_DB,
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
  });

  const results = []; // [항목, pass, 비고]

  try {
    // ── 1. 행 수 대조 (기준 = 스냅샷 실측) ──
    console.log('── 1. 행 수 대조 (v1 스냅샷 실측 = 대상 DB) ──');
    for (const t of MIGRATED_TABLES) {
      const v1c = sqlite.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
      const v2c = parseInt((await pg.query(`SELECT COUNT(*) c FROM ${t}`)).rows[0].c);
      const ref = REF_EXPECTED[t];
      const pass = v1c === v2c;
      console.log(`  [${t}] 스냅샷=${v1c} | DB=${v2c}${ref != null ? ` | 참고기대=${ref}${v1c !== ref ? ' (스냅샷과 상이!)' : ''}` : ''} ${pass ? '✅' : '❌'}`);
      results.push([`행수 ${t}`, pass, `스냅샷=${v1c}, DB=${v2c}`]);
    }
    // subnets: v1에 없음 — 운영 v2 덤프 재적용분. 참고기대 9
    const subnetsCnt = parseInt((await pg.query('SELECT COUNT(*) c FROM subnets')).rows[0].c);
    console.log(`  [subnets] DB=${subnetsCnt} | 참고기대=9 (운영 v2 덤프 재적용) ${subnetsCnt === 9 ? '✅' : '❌'}`);
    results.push(['행수 subnets(재적용)', subnetsCnt === 9, `DB=${subnetsCnt}, 기대=9`]);

    // ── 2. EUL 규칙 기반 대조 ──
    console.log('\n── 2. EUL (migrate-eul 규칙 기반 기대치) ──');
    const exp = eulExpectedFromSnapshot(sqlite);
    const eulCnt = parseInt((await pg.query('SELECT COUNT(*) c FROM equipment_usage_logs')).rows[0].c);
    const { rows: distRows } = await pg.query(
      'SELECT event_type, COUNT(*) c FROM equipment_usage_logs GROUP BY event_type ORDER BY event_type');
    const dbDist = Object.fromEntries(distRows.map(r => [r.event_type, parseInt(r.c)]));
    console.log(`  v1 입력 ${exp.v1Rows}행 → 기대 이벤트 ${exp.total} (base ${exp.base} + returned ${exp.returnedExtra}, 미매핑 ${exp.unmapped})`);
    console.log(`  기대 분포: ${JSON.stringify(exp.dist)}`);
    console.log(`  DB   분포: ${JSON.stringify(dbDist)} | 총 ${eulCnt}`);
    const distMatch = eulCnt === exp.total &&
      Object.keys({ ...exp.dist, ...dbDist }).every(k => (exp.dist[k] || 0) === (dbDist[k] || 0));
    results.push(['EUL 총수+분포', distMatch, `기대=${exp.total}, DB=${eulCnt}`]);

    // returned 표본: return_date 있는 v1 행 → returned 이벤트 event_date=return_date + 마커
    const retRows = exp.rows.filter(r => STATUS_MAP[r.status] && !isEmpty(r.return_date)).slice(0, 5);
    let retOk = 0;
    for (const r of retRows) {
      const { rows } = await pg.query(
        `SELECT 1 FROM equipment_usage_logs
         WHERE event_type='returned' AND event_date=$1::date
           AND management_number IS NOT DISTINCT FROM $2 AND notes LIKE '%' || $3`,
        [r.return_date, isEmpty(r.management_number) ? null : r.management_number, RETURNED_MARKER]);
      if (rows.length) retOk++;
    }
    console.log(`  returned 표본: ${retOk}/${retRows.length} 규칙 일치 (event_date=return_date, 마커 존재)`);
    results.push(['EUL returned 표본', retOk === retRows.length, `${retOk}/${retRows.length}`]);

    // usage_date=null 표본: base 이벤트 event_date=date(created_at) + 추정 마커
    const estRows = exp.rows.filter(r => STATUS_MAP[r.status] && isEmpty(r.usage_date)).slice(0, 5);
    let estOk = 0;
    for (const r of estRows) {
      const expectDate = String(r.created_at).slice(0, 10);
      const { rows } = await pg.query(
        `SELECT 1 FROM equipment_usage_logs
         WHERE event_type=$1 AND event_date=$2::date
           AND management_number IS NOT DISTINCT FROM $3 AND notes LIKE '%' || $4 || '%'`,
        [STATUS_MAP[r.status], expectDate,
         isEmpty(r.management_number) ? null : r.management_number, ESTIMATE_MARKER]);
      if (rows.length) estOk++;
    }
    console.log(`  usage_date=null 표본: ${estOk}/${estRows.length} 규칙 일치 (event_date=created_at 날짜, 추정 마커)`);
    results.push(['EUL usage_date=null 표본', estOk === estRows.length, `${estOk}/${estRows.length}`]);

    // ── 3. FK 정합 (고아 0) ──
    console.log('\n── 3. FK 정합 (고아 0) ──');
    const fkChecks = [
      ['asset_ips→assets', `SELECT COUNT(*) c FROM asset_ips x LEFT JOIN assets a ON a.id=x.asset_id WHERE x.asset_id IS NOT NULL AND a.id IS NULL`],
      ['asset_credentials→assets', `SELECT COUNT(*) c FROM asset_credentials x LEFT JOIN assets a ON a.id=x.asset_id WHERE x.asset_id IS NOT NULL AND a.id IS NULL`],
      ['computing_modules→assets', `SELECT COUNT(*) c FROM computing_modules x LEFT JOIN assets a ON a.id=x.asset_id WHERE x.asset_id IS NOT NULL AND a.id IS NULL`],
      ['photos(entity=asset)→assets', `SELECT COUNT(*) c FROM photos x LEFT JOIN assets a ON a.id=x.entity_id WHERE x.entity_type='asset' AND a.id IS NULL`],
      ['EUL→assets', `SELECT COUNT(*) c FROM equipment_usage_logs x LEFT JOIN assets a ON a.id=x.asset_id WHERE x.asset_id IS NOT NULL AND a.id IS NULL`],
      ['racks→server_rooms', `SELECT COUNT(*) c FROM racks x LEFT JOIN server_rooms s ON s.id=x.room_id WHERE x.room_id IS NOT NULL AND s.id IS NULL`],
      ['assets→racks', `SELECT COUNT(*) c FROM assets x LEFT JOIN racks r ON r.id=x.rack_id WHERE x.rack_id IS NOT NULL AND r.id IS NULL`],
    ];
    for (const [label, q] of fkChecks) {
      const c = parseInt((await pg.query(q)).rows[0].c);
      console.log(`  [${label}] 고아 ${c} ${c === 0 ? '✅' : '❌'}`);
      results.push([`FK ${label}`, c === 0, `고아 ${c}`]);
    }

    // ── 4. 시퀀스: nextval > max(id) ──
    console.log('\n── 4. 시퀀스 (nextval > max(id)) ──');
    const { rows: seqTables } = await pg.query(`
      SELECT table_name, pg_get_serial_sequence(table_name, 'id') AS seq
      FROM information_schema.columns
      WHERE table_schema='public' AND column_name='id' AND column_default LIKE 'nextval%'
      ORDER BY table_name`);
    for (const { table_name, seq } of seqTables) {
      const { rows: [s] } = await pg.query(`SELECT last_value, is_called FROM ${seq}`);
      const next = s.is_called ? BigInt(s.last_value) + 1n : BigInt(s.last_value);
      const maxId = BigInt((await pg.query(`SELECT COALESCE(MAX(id),0) m FROM ${table_name}`)).rows[0].m);
      const pass = next > maxId;
      console.log(`  [${table_name}] max=${maxId} next=${next} ${pass ? '✅' : '❌'}`);
      results.push([`시퀀스 ${table_name}`, pass, `max=${maxId}, next=${next}`]);
    }

    // ── 5. 랙 삭제 반영 ──
    const rackCnt = parseInt((await pg.query('SELECT COUNT(*) c FROM racks')).rows[0].c);
    const rackPass = rackCnt === 23;
    console.log(`\n── 5. 랙 삭제 반영: racks=${rackCnt} (기대 23, 27이면 실패) ${rackPass ? '✅' : '❌'}`);
    results.push(['racks=23 (v1 실삭제 4건 반영)', rackPass, `racks=${rackCnt}`]);

    // ── 6. 표본 내용 대조 ──
    console.log('\n── 6. 표본 내용 대조 (컬럼 단위) ──');
    await sampleDiff(sqlite, pg, 'assets', results);
    await sampleDiff(sqlite, pg, 'module_inventory', results);
    for (const r of results.slice(-2)) console.log(`  [${r[0]}] ${r[1] ? '✅' : '❌'} ${r[2]}`);

    // ── 최종 ──
    const fails = results.filter(r => !r[1]);
    console.log('\n=== 검증 결과 요약 ===');
    console.log(`총 ${results.length}항목 | PASS ${results.length - fails.length} | FAIL ${fails.length}`);
    if (fails.length) {
      for (const f of fails) console.log(`  ❌ ${f[0]} — ${f[2]}`);
      process.exitCode = 1;
    } else {
      console.log('✅ 전 항목 PASS');
    }
  } finally {
    sqlite.close();
    await pg.end();
  }
}

main().catch(e => { console.error('에러:', e); process.exit(1); });
