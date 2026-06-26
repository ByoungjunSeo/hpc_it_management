#!/usr/bin/env node
/**
 * B-2.8b: equipment_usage_logs 데이터 이전 (v1 SQLite → v2 PostgreSQL)
 *
 * 모드 (반드시 하나 지정):
 *   --check     읽기만. v2 현재 행수 + 변환 행수/분포 출력. DB 쓰기 없음.
 *   --single    BEGIN → 대표행 INSERT → SELECT 확인 → ROLLBACK. 흔적 안 남음.
 *   --rehearse  BEGIN → 전량(1036) INSERT → 검증 → ROLLBACK. 흔적 안 남음.
 *   --commit    BEGIN → 전량 INSERT → 검증 → COMMIT. 실제 반영 (단 한 번!).
 *
 * 안전장치:
 *   - Q5 가드: --rehearse/--commit 시작 시 v2 eul 행수 != 0 이면 즉시 중단.
 *   - 변환 함수는 dryrun-eul.js와 동일 규칙 (D1~D5, E1, E2).
 *   - JSONB는 JSON.stringify + ::jsonb 캐스팅. 파라미터 바인딩만 사용.
 *   - v1 SQLite는 READONLY.
 *   - created_by = 'migration' (Q3).
 */
const path = require('path');
const Database = require('better-sqlite3');
const { Pool } = require('pg');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const V1_DB = '/mlcommons_cm/hpc_it_management/app/data/it_assets.db';

const MODE = (() => {
  const flags = ['--check', '--single', '--rehearse', '--commit'].filter(f => process.argv.includes(f));
  if (flags.length !== 1) {
    console.error('모드를 정확히 하나 지정하세요: --check | --single | --rehearse | --commit');
    process.exit(1);
  }
  return flags[0].slice(2);
})();

// ── 변환 로직 (dryrun-eul.js와 동일) ─────────────────────────────
const STATUS_MAP = { '입고': 'incoming', '사용중': 'in_use', '반납완료': 'in_use' };
const isEmpty = (v) => v == null || v === '';
const clean = (v) => (isEmpty(v) ? null : v);
const isHwPlaceholder = (v) => isEmpty(v) || String(v).trim() === '-';
const ESTIMATE_MARKER = ' [event_date estimated from created_at]';
const RETURNED_MARKER = '[returned event migrated from return_date]';

function buildHardware(r) {
  const items = [];
  const push = (type, code, num) => {
    if (!isHwPlaceholder(code)) items.push({ type, code, num: isEmpty(num) ? null : num });
  };
  push('cpu', r.cpu_type, r.cpu_num);
  push('memory', r.mem1_type, r.mem1_num);
  push('memory', r.mem2_type, r.mem2_num);
  push('disk', r.disk1_part, r.disk1_num);
  push('disk', r.disk2_part, r.disk2_num);
  push('disk', r.disk3_part, r.disk3_num);
  push('disk', r.disk4_part, r.disk4_num);
  push('network', r.nic1_type, r.nic1_num);
  push('network', r.nic2_type, r.nic2_num);
  push('network', r.nic3_type, r.nic3_num);
  push('network', r.nic4_type, r.nic4_num);
  push('raid', r.raid_type, r.raid_num);
  push('gpu', r.gpu1_type, r.gpu1_num);
  push('gpu', r.gpu2_type, r.gpu2_num);
  return items.length ? items : null;
}

function buildNetwork(r) {
  const items = [];
  const push = (label, ip) => { if (!isEmpty(ip)) items.push({ label, ip }); };
  push('ip1', r.ip1); push('ip2', r.ip2); push('ip3', r.ip3); push('ip4', r.ip4);
  push('bmc', r.bmc); push('ib1', r.ib1); push('ib2', r.ib2);
  return items.length ? items : null;
}

function resolveEventDate(r) {
  if (!isEmpty(r.usage_date)) return { date: r.usage_date, estimated: false };
  return { date: String(r.created_at).slice(0, 10), estimated: true };
}

function buildNotes(baseNotes, estimated) {
  let n = clean(baseNotes) || '';
  if (estimated) n = (n + ESTIMATE_MARKER).trim();
  return n === '' ? null : n;
}

/** v1 row → v2 이벤트 객체 1~2개 배열 */
function convertRow(r, assetMap) {
  const baseType = STATUS_MAP[r.status];
  if (!baseType) return { events: [], unmapped: { id: r.id, status: r.status } };

  const assetId = assetMap.has(r.management_number) ? assetMap.get(r.management_number) : null;
  const { date: eventDate, estimated } = resolveEventDate(r);
  const hardware = buildHardware(r);
  const network = buildNetwork(r);

  const base = {
    event_type: baseType,
    event_date: eventDate,
    asset_id: assetId,
    management_number: clean(r.management_number),
    asset_number: clean(r.asset_number),
    model_name: clean(r.model_name),
    user_name: clean(r.user_name),
    test_name: clean(r.test_name),
    test_detail: clean(r.test_detail),
    room: clean(r.room),
    rack: clean(r.rack),
    unit: clean(r.unit),
    hardware_snapshot: hardware,
    network_snapshot: network,
    credentials_snapshot: null, // D2 제외
    ownership: clean(r.ownership) || 'company',
    os: clean(r.os),
    notes: buildNotes(r.notes, estimated),
    created_by: 'migration', // Q3
  };
  const events = [base];

  if (!isEmpty(r.return_date)) {
    const origNotes = clean(r.notes);
    const retNotes = origNotes ? (origNotes + ' ' + RETURNED_MARKER) : RETURNED_MARKER;
    events.push({ ...base, event_type: 'returned', event_date: r.return_date, notes: retNotes });
  }
  return { events, unmapped: null };
}

// ── INSERT 컬럼/SQL (21컬럼 중 id·created_at은 DEFAULT에 맡김) ──
const COLS = [
  'event_type', 'event_date', 'asset_id', 'management_number', 'asset_number',
  'model_name', 'user_name', 'test_name', 'test_detail', 'room', 'rack', 'unit',
  'hardware_snapshot', 'network_snapshot', 'credentials_snapshot',
  'ownership', 'os', 'notes', 'created_by',
];
// JSONB 컬럼은 ::jsonb 캐스팅
const JSONB_COLS = new Set(['hardware_snapshot', 'network_snapshot', 'credentials_snapshot']);

function buildInsert() {
  const placeholders = COLS.map((c, i) =>
    JSONB_COLS.has(c) ? `$${i + 1}::jsonb` : `$${i + 1}`
  );
  return `INSERT INTO equipment_usage_logs (${COLS.join(', ')}) VALUES (${placeholders.join(', ')})`;
}

function toParams(ev) {
  return COLS.map(c => {
    const v = ev[c];
    if (JSONB_COLS.has(c)) return v == null ? null : JSON.stringify(v);
    return v == null ? null : v;
  });
}

// ── 메인 ─────────────────────────────────────────────────────────
async function main() {
  // v1 읽기 (readonly)
  const sqlite = new Database(V1_DB, { readonly: true, fileMustExist: true });
  const assetMap = new Map();
  for (const a of sqlite.prepare('SELECT id, management_number FROM assets').all()) {
    if (a.management_number != null && a.management_number !== '') assetMap.set(a.management_number, a.id);
  }
  const rows = sqlite.prepare('SELECT * FROM equipment_usage_logs ORDER BY id').all();

  // 변환
  const events = [];
  const unmapped = [];
  let baseCount = 0, returnedExtra = 0;
  const dist = {};
  for (const r of rows) {
    const { events: evs, unmapped: um } = convertRow(r, assetMap);
    if (um) { unmapped.push(um); continue; }
    baseCount++;
    if (evs.length === 2) returnedExtra++;
    for (const e of evs) { events.push(e); dist[e.event_type] = (dist[e.event_type] || 0) + 1; }
  }
  sqlite.close();

  const nullAsset = events.filter(e => e.asset_id == null).length;
  console.log('── 변환 결과 ──');
  console.log('v1 입력:', rows.length, '| base:', baseCount, '| returned 추가:', returnedExtra);
  console.log('총 이벤트:', events.length, '(목표 1036)');
  console.log('event_type 분포:', JSON.stringify(dist));
  console.log('asset_id NULL:', nullAsset, '(목표 216)');
  console.log('미매핑 status:', unmapped.length, unmapped.length ? JSON.stringify(unmapped) : '(없음 ✓)');

  if (unmapped.length) { console.error('미매핑 status 존재 → 중단'); process.exit(1); }

  if (MODE === 'check') {
    const pg = makePool();
    const { rows: [{ count }] } = await pg.query('SELECT count(*) FROM equipment_usage_logs');
    console.log('\n[check] v2 eul 현재 행수:', count, Number(count) === 0 ? '(비어있음 ✓)' : '(⚠ 0 아님!)');
    await pg.end();
    return;
  }

  const pg = makePool();
  try {
    // Q5 가드 (rehearse/commit)
    if (MODE === 'rehearse' || MODE === 'commit') {
      const { rows: [{ count }] } = await pg.query('SELECT count(*) FROM equipment_usage_logs');
      if (Number(count) !== 0) {
        console.error(`\n[가드] v2 eul 행수 = ${count} (0 아님). 중복 방지 위해 중단합니다.`);
        await pg.end();
        process.exit(1);
      }
    }

    const sql = buildInsert();

    if (MODE === 'single') {
      // 대표행: hardware+network 둘 다 있는 첫 base + returned_extra 하나
      const withBoth = events.find(e => e.hardware_snapshot && e.network_snapshot);
      const aReturned = events.find(e => e.event_type === 'returned');
      const samples = [withBoth, aReturned].filter(Boolean);
      console.log('\n[single] 대표행', samples.length, '건 INSERT 테스트 (ROLLBACK 예정)');
      await pg.query('BEGIN');
      for (const ev of samples) await pg.query(sql, toParams(ev));
      const chk = await pg.query(
        `SELECT id, event_type, event_date, asset_id, management_number,
                hardware_snapshot->0->>'code' AS hw_first_code,
                network_snapshot->0->>'ip'    AS net_first_ip,
                jsonb_array_length(hardware_snapshot) AS hw_len,
                created_by, left(notes,60) AS notes_head
         FROM equipment_usage_logs ORDER BY id`
      );
      console.table(chk.rows);
      await pg.query('ROLLBACK');
      console.log('ROLLBACK 완료 — 흔적 없음. CHECK/NOT NULL/JSONB 통과 확인.');
    } else {
      // rehearse / commit 공통: 전량 INSERT
      console.log(`\n[${MODE}] 전량 ${events.length}건 INSERT 시작...`);
      await pg.query('BEGIN');
      for (const ev of events) await pg.query(sql, toParams(ev));

      const cnt = await pg.query('SELECT count(*) FROM equipment_usage_logs');
      const byType = await pg.query(
        'SELECT event_type, count(*) FROM equipment_usage_logs GROUP BY event_type ORDER BY event_type'
      );
      const nullCnt = await pg.query('SELECT count(*) FROM equipment_usage_logs WHERE asset_id IS NULL');
      console.log('INSERT 후 행수:', cnt.rows[0].count, '(목표 1036)');
      console.log('event_type 분포:');
      console.table(byType.rows);
      console.log('asset_id NULL:', nullCnt.rows[0].count, '(목표 216)');

      if (MODE === 'rehearse') {
        await pg.query('ROLLBACK');
        console.log('\nROLLBACK 완료 — 흔적 없음. 본실행과 동일 경로 리허설 성공.');
      } else {
        await pg.query('COMMIT');
        console.log('\n✅ COMMIT 완료 — 실제 반영됨.');
      }
    }
  } catch (e) {
    try { await pg.query('ROLLBACK'); } catch (_) {}
    console.error('\n❌ 오류 → ROLLBACK:', e.message);
    process.exitCode = 1;
  } finally {
    await pg.end();
  }
}

function makePool() {
  return new Pool({
    host: '127.0.0.1',
    port: 5433,
    database: process.env.POSTGRES_DB,
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
  });
}

main().catch(e => { console.error(e); process.exit(1); });
