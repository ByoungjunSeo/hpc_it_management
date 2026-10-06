#!/usr/bin/env node
/*
 * IT 자산관리 시스템 v2 — PoC 체험용 데모 데이터 투입 스크립트
 *
 * 대상 버전: v2.3.0 이상 (랙 내장형 CDU·DLC 랙 포함)
 *
 * 실행 (Windows PowerShell / 리눅스 공통, 배포 폴더에서):
 *   docker cp seed-demo.js it-assets-app-1:/app/scripts/seed-demo.js
 *   docker exec it-assets-app-1 node scripts/seed-demo.js
 *
 * - 앱 화면과 같은 경로(HTTP 폼 요청)로 데이터를 넣으므로 이력·감사 로그·IP 풀이 실제 사용과 똑같이 쌓입니다.
 * - ★ 빈 설치본에서만 동작합니다. 자산·서버실·서브넷이 하나라도 있으면 아무것도 하지 않고 종료합니다.
 * - 모든 데이터 이름은 DEMO- 로 시작하고, IP는 예시 대역(192.168.250.0/24, 192.168.251.0/24)만 사용합니다.
 * - admin 비밀번호를 바꿨다면: docker exec -e ADMIN_PASSWORD=<현재비밀번호> it-assets-app-1 node scripts/seed-demo.js
 */
'use strict';

const { Pool } = require('pg');

const BASE = process.env.SEED_BASE_URL || 'http://localhost:' + (process.env.APP_PORT || 3001);
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || process.env.INITIAL_ADMIN_PASSWORD;

const pool = new Pool({
  host: process.env.PGHOST || 'db',
  port: parseInt(process.env.PGPORT || '5432', 10),
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.POSTGRES_DB
});

// ---------------------------------------------------------------- HTTP helpers
const jar = {};
function cookieHeader() { return Object.entries(jar).map(([k, v]) => k + '=' + v).join('; '); }
function keepCookies(res) {
  const list = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
  for (const c of list) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    if (i > 0) jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
}
async function get(path) {
  const res = await fetch(BASE + path, { headers: { cookie: cookieHeader() }, redirect: 'manual' });
  keepCookies(res);
  return { status: res.status, location: res.headers.get('location'), text: await res.text() };
}
function decode(s) {
  return s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
// POST 후 리다이렉트 페이지의 flash(성공/오류) 메시지를 읽어 실패를 감지한다.
async function post(path, fields, { files, label } = {}) {
  let body;
  const headers = { cookie: cookieHeader() };
  if (files) {
    body = new FormData();
    for (const [k, v] of fields) body.append(k, v);
    for (const f of files) body.append(f.field, new Blob([f.data], { type: f.type }), f.name);
  } else {
    body = new URLSearchParams();
    for (const [k, v] of fields) body.append(k, v);
  }
  const res = await fetch(BASE + path, { method: 'POST', headers, body, redirect: 'manual' });
  keepCookies(res);
  if (res.status >= 400) throw new Error(`${label || path}: HTTP ${res.status}`);
  const loc = res.headers.get('location');
  if (!loc) return;
  const page = await get(loc);
  const err = page.text.match(/<div class="alert alert-error">([\s\S]*?)<\/div>/);
  if (err) {
    const msg = decode(err[1].trim());
    // IP 풀 미포함 경고는 오류가 아님(데모 IP는 모두 풀 안에 있으므로 여기 오면 실제 문제)
    throw new Error(`${label || path}: ${msg}`);
  }
}
const q = async (sql, params) => (await pool.query(sql, params)).rows;
const step = (n, msg) => console.log(`[${n}] ${msg}`);

// 1x1 PNG (데모 사진)
const DEMO_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

function daysFromToday(n) {
  const d = new Date(); d.setDate(d.getDate() + n);
  return d.toISOString().split('T')[0];
}

// ---------------------------------------------------------------- demo data
const ROOM = 'DEMO-서버실';
// name, rack_type (dlc = 수냉 DLC 랙, v2.3.0~)
const RACKS = [['DEMO-RACK-A', 'standard'], ['DEMO-RACK-B', 'standard'], ['DEMO-RACK-C', 'dlc']];
const SUBNETS = [
  { name: 'DEMO 관리망', cidr: '192.168.250.0/24', zone: 'hpc', desc: '데모용 예시 대역(서버 OS·관리)' },
  { name: 'DEMO BMC망', cidr: '192.168.251.0/24', zone: 'hpc', desc: '데모용 예시 대역(BMC/IPMI)' }
];
// type, mgmt, maker, model, U, rack, unit, user, purpose, mgmtIP, bmcIP
const EQUIP = [
  ['switch',  'DEMO-SW-01', 'Arista',     'DCS-7050SX3 (예시)',      1, 'DEMO-RACK-A', 'U42',      '인프라 담당', '서버 관리망 스위치', '192.168.250.2',  null],
  ['server',  'DEMO-SV-01', 'Supermicro', 'SYS-421GE-TNRT (예시)',   4, 'DEMO-RACK-A', 'U30-U33',  '홍길동',     'AI 학습 벤치마크',   '192.168.250.11', '192.168.251.11'],
  ['server',  'DEMO-SV-02', 'Supermicro', 'SYS-421GE-TNRT (예시)',   4, 'DEMO-RACK-A', 'U25-U28',  '홍길동',     'AI 추론 벤치마크',   '192.168.250.12', '192.168.251.12'],
  ['server',  'DEMO-SV-03', 'Dell',       'PowerEdge R760 (예시)',   2, 'DEMO-RACK-A', 'U20-U21',  '김철수',     'CPU 성능 시험',      '192.168.250.13', '192.168.251.13'],
  ['server',  'DEMO-SV-04', 'Dell',       'PowerEdge R760 (예시)',   2, 'DEMO-RACK-A', 'U17-U18',  '김철수',     'CPU 성능 시험',      '192.168.250.14', '192.168.251.14'],
  ['storage', 'DEMO-ST-01', 'NetApp',     'AFF A400 (예시)',         4, 'DEMO-RACK-B', 'U30-U33',  '이영희',     '스토리지 성능 시험', '192.168.250.21', '192.168.251.21'],
  ['server',  'DEMO-SV-05', 'Lenovo',     'ThinkSystem SR650 V3 (예시)', 2, 'DEMO-RACK-B', 'U20-U21', '이영희',  'I/O 벤치마크',       '192.168.250.15', '192.168.251.15'],
  ['server',  'DEMO-SV-06', 'Lenovo',     'ThinkSystem SR650 V3 (예시)', 2, 'DEMO-RACK-B', 'U17-U18', '박민수',  '시험 종료 예정(반납 시연용)', '192.168.250.16', '192.168.251.16'],
  ['server',  'DEMO-SV-07', 'Supermicro', 'SYS-A21GE-NBRT 수냉 (예시)', 4, 'DEMO-RACK-C', 'U10-U13', '홍길동',  'DLC 서버 열 시험',   '192.168.250.17', '192.168.251.17'],
  ['cdu',     'DEMO-CDU-01', 'Vertiv',    'CoolChip CDU 100 (예시)', 4, 'DEMO-RACK-C', 'U1-U4',    '인프라 담당', '랙 내장형 CDU (DLC 냉각)', null, null]
];
// type, code, maker, model, capacity, qty
const PARTS = [
  ['cpu',    'DEMO-CPU-01', 'Intel',   'Xeon Gold 6430 (예시)',  '32C',     8],
  ['memory', 'DEMO-MEM-01', 'Samsung', 'DDR5-4800 RDIMM (예시)', '64GB',   32],
  ['disk',   'DEMO-SSD-01', 'Samsung', 'PM9A3 NVMe (예시)',      '3.84TB', 12],
  ['gpu',    'DEMO-GPU-01', 'NVIDIA',  'L40S (예시)',            '48GB',    6]
];

// ---------------------------------------------------------------- main
async function main() {
  if (!ADMIN_PASSWORD) throw new Error('admin 비밀번호를 알 수 없습니다. -e ADMIN_PASSWORD=<비밀번호> 로 지정하세요.');

  // 0) 안전장치: 빈 설치본에서만 실행
  const [cnt] = await q(`SELECT (SELECT COUNT(*) FROM assets)::int a, (SELECT COUNT(*) FROM server_rooms)::int r,
                                (SELECT COUNT(*) FROM subnets)::int s, (SELECT COUNT(*) FROM module_inventory)::int m`);
  if (cnt.a + cnt.r + cnt.s + cnt.m > 0) {
    console.log(`중단: 이미 데이터가 있습니다 (자산 ${cnt.a}, 서버실 ${cnt.r}, 서브넷 ${cnt.s}, 부품 ${cnt.m}).`);
    console.log('데모 데이터는 새로 설치한 빈 시스템에서만 넣을 수 있습니다. 운영 데이터는 건드리지 않았습니다.');
    process.exitCode = 2;
    return;
  }

  // 1) 로그인
  await get('/login');
  const login = await fetch(BASE + '/login', {
    method: 'POST', headers: { cookie: cookieHeader() }, redirect: 'manual',
    body: new URLSearchParams({ username: ADMIN_USER, password: ADMIN_PASSWORD })
  });
  keepCookies(login);
  if ((login.headers.get('location') || '').includes('/login')) throw new Error('로그인 실패: admin 비밀번호를 확인하세요 (-e ADMIN_PASSWORD=...).');
  step(1, '로그인 완료');

  // 2) 서브넷 (IP 풀 자동 생성)
  for (const s of SUBNETS) {
    await post('/ip-management/subnets', [['name', s.name], ['cidr', s.cidr], ['network_zone', s.zone], ['description', s.desc]], { label: '서브넷 ' + s.cidr });
  }
  step(2, `서브넷 ${SUBNETS.length}개 등록 (IP 풀 자동 생성)`);

  // 3) 서버실 + 랙
  await post('/rooms', [['name', ROOM], ['location', '본관 3층 (예시)'], ['description', 'PoC 데모용 서버실'], ['location_type', 'server_room']], { label: '서버실' });
  const [room] = await q('SELECT id FROM server_rooms WHERE name = $1', [ROOM]);
  for (let i = 0; i < RACKS.length; i++) {
    const [rname, rtype] = RACKS[i];
    await post(`/rooms/${room.id}/racks`, [['name', rname], ['total_units', '42'], ['row_position', '1'], ['col_position', String(i + 1)], ['rack_type', rtype], ['description', rtype === 'dlc' ? 'PoC 데모 DLC(수냉) 랙' : 'PoC 데모 랙']], { label: '랙 ' + rname });
  }
  step(3, `서버실 1개, 랙 ${RACKS.length}개 등록 (DLC 랙 1개 포함)`);

  // 4) 장비 입고 (DEMO-SV-01은 입고 사진 포함)
  const incomingDate = daysFromToday(-30);
  for (const e of EQUIP) {
    const [type, mgmt, maker, model, u] = e;
    const fields = [['asset_type', type], ['management_number', mgmt], ['manufacturer', maker], ['model_name', model],
      ['u_size', String(u)], ['ownership', 'company'], ['incoming_date', incomingDate], ['serial_number', 'SN-' + mgmt], ['notes', 'PoC 데모 데이터']];
    const files = mgmt === 'DEMO-SV-01' ? [{ field: 'photos', name: 'demo-incoming.png', type: 'image/png', data: DEMO_PNG }] : undefined;
    await post('/inventory/incoming', fields, { files, label: '입고 ' + mgmt });
  }
  // 업체 장비 1대 (관리번호 자동 생성: 업체명 기반)
  await post('/inventory/incoming', [['asset_type', 'server'], ['vendor_id', '__new__'], ['new_vendor_name', 'DEMO업체'],
    ['manufacturer', 'HPE'], ['model_name', 'ProLiant DL380 Gen11 (예시, 업체 반입)'], ['u_size', '2'], ['ownership', 'vendor'],
    ['incoming_date', daysFromToday(-7)], ['notes', 'PoC 데모 — 업체 반입 장비(보관 중)']], { label: '업체 장비 입고' });
  step(4, `장비 ${EQUIP.length + 1}대 입고 (사진 1장 포함, 업체 반입 1대는 보관 상태)`);

  // 5) 사용등록 — 랙 위치·사용자·IP 지정
  const usageDate = daysFromToday(-28);
  for (const e of EQUIP) {
    const [type, mgmt, , model, , rack, unit, user, purpose, ip, bmc] = e;
    const fields = [['usage_asset_type', type], ['management_number', mgmt], ['model_name', model], ['ownership', 'company'],
      ['usage_date', usageDate], ['room', ROOM], ['rack', rack], ['unit', unit], ['user_name', user], ['test_name', purpose]];
    if (ip) fields.push(['ip_purposes[]', 'management'], ['ip_values[]', ip], ['ip_iface_types[]', 'Ethernet'], ['ip_speeds[]', '10G']);
    if (bmc) fields.push(['ip_purposes[]', 'bmc'], ['ip_values[]', bmc], ['ip_iface_types[]', 'Ethernet'], ['ip_speeds[]', '1G']);
    await post('/inventory', fields, { label: '사용등록 ' + mgmt });
  }
  step(5, `장비 ${EQUIP.length}대 사용등록 (랙 배치 + IP 할당, 랙 내장형 CDU 포함)`);

  // 6) 부품 입고 (DEMO-GPU-01은 사진 포함)
  for (const [type, code, maker, model, cap, qty] of PARTS) {
    const files = code === 'DEMO-GPU-01' ? [{ field: 'photos', name: 'demo-part.png', type: 'image/png', data: DEMO_PNG }] : undefined;
    await post('/inventory/incoming', [['asset_type', type], ['management_number', code], ['manufacturer', maker], ['model_name', model],
      ['capacity', cap], ['quantity', String(qty)], ['ownership', 'company'], ['incoming_date', incomingDate], ['notes', 'PoC 데모 부품']],
      { files, label: '부품 입고 ' + code });
  }
  step(6, `부품 ${PARTS.length}종 입고 (사진 1장 포함)`);

  // 7) 부품 장착 — GPU 2장을 DEMO-SV-01에 장착
  const [sv01] = await q("SELECT id FROM assets WHERE management_number = 'DEMO-SV-01'");
  // 부품 재고 화면의 '모듈 설치'와 같은 경로: 보관 수량 차감 + 설치 이력 기록
  await post('/module-inventory/modules', [['asset_id', String(sv01.id)], ['module_type', 'gpu'], ['model', 'L40S (예시)'],
    ['manufacturer', 'NVIDIA'], ['capacity', '48GB'], ['count', '2'], ['specification', 'DEMO-GPU-01'], ['slot_info', 'PCIe 1-2'],
    ['notes', 'PoC 데모 장착'], ['returnTo', '/assets/' + sv01.id]], { label: 'GPU 장착' });
  step(7, 'GPU 2장을 DEMO-SV-01에 장착 (부품 재고 사용중 반영)');

  // 8) 반납 — DEMO-SV-06 (IP 자동 회수 시연)
  const [log06] = await q(`SELECT e.id FROM equipment_usage_logs e WHERE e.management_number = 'DEMO-SV-06' AND e.event_type = 'in_use'
                           ORDER BY e.id DESC LIMIT 1`);
  if (!log06) throw new Error('DEMO-SV-06 사용 이력을 찾지 못했습니다.');
  await post(`/inventory/${log06.id}/return`, [['return_date', daysFromToday(-2)], ['returnTo', '/inventory']], { label: '반납 DEMO-SV-06' });
  step(8, 'DEMO-SV-06 반납 (할당 IP 2개 자동 회수)');

  // 9) 대여 장부 — 협력사에 SSD 2개 대출
  await post('/lendings', [['direction', 'outbound'], ['counterparty', 'DEMO협력사'], ['loan_date', daysFromToday(-5)], ['due_date', daysFromToday(25)],
    ['notes', 'PoC 데모 대여'], ['item_type', 'disk'], ['item_code', 'DEMO-SSD-01'], ['item_quantity', '2'], ['item_description', '성능 시험용 SSD 대여']],
    { label: '대여 등록' });
  step(9, 'DEMO협력사에 SSD 2개 대여 (부품 재고 자동 차감)');

  // 10) 체험용 계정
  for (const [u, role, name] of [['demo_maint', 'maintenance', '데모 유지보수'], ['demo_viewer', 'viewer', '데모 조회전용']]) {
    await post('/admin/users', [['username', u], ['password', 'Demo1234!'], ['role', role], ['display_name', name]], { label: '계정 ' + u });
  }
  step(10, '체험 계정 2개 생성 (demo_maint / demo_viewer, 비밀번호 Demo1234!)');

  // ---- 결과 확인
  const [r] = await q(`SELECT
      (SELECT COUNT(*) FROM assets)::int assets,
      (SELECT COUNT(*) FROM assets WHERE rack_id IS NOT NULL)::int racked,
      (SELECT COUNT(*) FROM module_inventory)::int parts,
      (SELECT COUNT(*) FROM ip_addresses WHERE allocation_type = 'assigned')::int ip_assigned,
      (SELECT COUNT(*) FROM photos)::int photos,
      (SELECT COUNT(*) FROM lendings)::int lendings`);
  const [ret] = await q(`SELECT a.status, (SELECT COUNT(*) FROM ip_addresses i WHERE i.asset_id = a.id AND i.allocation_type = 'assigned')::int ips
                         FROM assets a WHERE a.management_number = 'DEMO-SV-06'`);
  console.log('');
  console.log('완료 — 결과 요약');
  console.log(`  자산 ${r.assets}대 (랙 배치 ${r.racked}대), 부품 ${r.parts}종, 할당 IP ${r.ip_assigned}개, 사진 ${r.photos}장, 대여 ${r.lendings}건`);
  console.log(`  반납 장비 DEMO-SV-06: 상태 ${ret.status}, 남은 할당 IP ${ret.ips}개 (0이면 정상 회수)`);
  console.log('');
  console.log('브라우저에서 확인: 랙 배치도(서버실 > DEMO-서버실), IP 관리, 입출고, 부품 재고, 대여 장부, 감사 로그');
}

main()
  .catch(err => { console.error('오류: ' + err.message); process.exitCode = 1; })
  .finally(() => pool.end());
