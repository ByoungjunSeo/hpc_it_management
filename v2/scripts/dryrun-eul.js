#!/usr/bin/env node
/**
 * B-2.8b 드라이런: equipment_usage_logs 변환 검증
 * - v1 SQLite를 READONLY로만 읽음
 * - PostgreSQL 일절 접근 안 함
 * - 출력: dryrun-eul-output.json (변환 결과 전체) + 콘솔 요약
 *
 * 확정 규칙:
 *   D1: 입고→incoming, 사용중→in_use, 반납완료→in_use(base)
 *   D2: credentials_snapshot 생성 안 함
 *   D3: hardware_snapshot {type,code,num} 재구성
 *   D4: event_date = usage_date ?? date(created_at), 추정 시 notes 마커
 *   D5-A: asset_id 매칭 안 되면 NULL, 행은 전부 보존
 *   return_date 있으면 returned 이벤트 추가 1행
 */
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const V1_DB = '/mlcommons_cm/hpc_it_management/app/data/it_assets.db';
const OUT = path.join(__dirname, 'dryrun-eul-output.json');

// READONLY 연결 (쓰기 불가 보장)
const db = new Database(V1_DB, { readonly: true, fileMustExist: true });

// asset_id 매핑: assets.management_number → assets.id
const assetMap = new Map();
for (const a of db.prepare('SELECT id, management_number FROM assets').all()) {
  if (a.management_number != null && a.management_number !== '') {
    assetMap.set(a.management_number, a.id);
  }
}

// status → base event_type (D1)
const STATUS_MAP = { '입고': 'incoming', '사용중': 'in_use', '반납완료': 'in_use' };

// 빈 값 헬퍼
const isEmpty = (v) => v == null || v === '';
const clean = (v) => (isEmpty(v) ? null : v);

// E1: 하드웨어 code placeholder 판정 — '-' 만 제외 ('2포트','1G' 등 실제값은 보존)
function isHwPlaceholder(v) {
  if (isEmpty(v)) return true;
  return String(v).trim() === '-';
}

// 하드웨어 스냅샷 재구성 (D3) — 값 있는 것만 {type,code,num}
function buildHardware(r) {
  const items = [];
  const push = (type, code, num) => {
    if (!isHwPlaceholder(code)) items.push({ type, code, num: isEmpty(num) ? null : num });
  };
  push('cpu',  r.cpu_type,  r.cpu_num);
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

// 네트워크 스냅샷 재구성 — ip1~ip4/bmc/ib1~ib2, 값 있는 것만
function buildNetwork(r) {
  const items = [];
  const push = (label, ip) => { if (!isEmpty(ip)) items.push({ label, ip }); };
  push('ip1', r.ip1);
  push('ip2', r.ip2);
  push('ip3', r.ip3);
  push('ip4', r.ip4);
  push('bmc', r.bmc);
  push('ib1', r.ib1);
  push('ib2', r.ib2);
  return items.length ? items : null;
}

// event_date 결정 (D4)
function resolveEventDate(r) {
  if (!isEmpty(r.usage_date)) return { date: r.usage_date, estimated: false };
  // created_at은 NULL 0건 확인됨. date 부분만.
  const d = String(r.created_at).slice(0, 10);
  return { date: d, estimated: true };
}

// notes 마커 (D4-b)
const ESTIMATE_MARKER = ' [event_date estimated from created_at]';
function buildNotes(baseNotes, estimated) {
  let n = clean(baseNotes) || '';
  if (estimated) n = (n + ESTIMATE_MARKER).trim();
  return n === '' ? null : n;
}

const rows = db.prepare('SELECT * FROM equipment_usage_logs ORDER BY id').all();

const out = [];
const stats = {
  v1_rows: rows.length,
  base_events: 0,
  returned_events: 0,
  event_type: {},
  asset_id_null: 0,
  asset_id_matched: 0,
  date_estimated: 0,
  hardware_present: 0,
  network_present: 0,
  unmapped_status: [],
};

function bump(type) { stats.event_type[type] = (stats.event_type[type] || 0) + 1; }

for (const r of rows) {
  const baseType = STATUS_MAP[r.status];
  if (!baseType) { stats.unmapped_status.push({ id: r.id, status: r.status }); continue; }

  const assetId = assetMap.has(r.management_number) ? assetMap.get(r.management_number) : null;
  if (assetId == null) stats.asset_id_null++; else stats.asset_id_matched++;

  const { date: eventDate, estimated } = resolveEventDate(r);
  if (estimated) stats.date_estimated++;

  const hardware = buildHardware(r);
  const network = buildNetwork(r);
  if (hardware) stats.hardware_present++;
  if (network) stats.network_present++;

  // base 이벤트
  const base = {
    _src_id: r.id,
    _event_kind: 'base',
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
    credentials_snapshot: null, // D2: 제외
    ownership: clean(r.ownership) || 'company',
    os: clean(r.os),
    notes: buildNotes(r.notes, estimated),
    created_by: null,
  };
  out.push(base);
  stats.base_events++;
  bump(baseType);

  // returned 추가 이벤트 (return_date 있을 때만)
  if (!isEmpty(r.return_date)) {
    // E2: returned 이벤트엔 반납 맥락 마커. 원본 notes가 있으면 앞에 두고 마커 추가.
    const RETURNED_MARKER = '[returned event migrated from return_date]';
    const origNotes = clean(r.notes);
    const retNotes = origNotes ? (origNotes + ' ' + RETURNED_MARKER) : RETURNED_MARKER;
    const ret = {
      ...base,
      _event_kind: 'returned_extra',
      event_type: 'returned',
      event_date: r.return_date,
      notes: retNotes,
    };
    out.push(ret);
    stats.returned_events++;
    bump('returned');
  }
}

fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
db.close();

// 콘솔 요약
console.log('=== B-2.8b 드라이런 요약 ===');
console.log('v1 입력 행수        :', stats.v1_rows);
console.log('base 이벤트 생성    :', stats.base_events);
console.log('returned 추가 생성  :', stats.returned_events);
console.log('총 출력 행수        :', out.length, '(목표 1036)');
console.log('event_type 분포     :', JSON.stringify(stats.event_type));
console.log('asset_id 매칭       :', stats.asset_id_matched, '/ NULL:', stats.asset_id_null);
console.log('event_date 추정     :', stats.date_estimated, '(목표 193)');
console.log('hardware 있는 행    :', stats.hardware_present);
console.log('network 있는 행     :', stats.network_present);
console.log('매핑 안 된 status   :', stats.unmapped_status.length, stats.unmapped_status.length ? JSON.stringify(stats.unmapped_status) : '(없음 ✓)');
console.log('');
console.log('출력 파일:', OUT);
