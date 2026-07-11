/**
 * B-7a: v1→v2 델타 규모 조사 (읽기 전용 — 이관·수정 없음)
 *
 * 입력:  v1 스냅샷 /tmp/v1_snapshot_b7a.sqlite (better-sqlite3 readonly)
 *        v2 PostgreSQL (v2/.env)
 * 실행:  timeout 120 node v2/scripts/b7a_delta_survey.js
 * 출력:  콘솔 표 + /tmp/b7a_delta_survey.json (STEP 6 보고서 작성용)
 *
 * 어떤 데이터도 쓰지 않는다. v1은 스냅샷 사본, v2는 SELECT만.
 */
const path = require('path');
const Database = require('better-sqlite3');
const { Client } = require('pg');

// .env 로드 (v2/.env)
require('fs').readFileSync(path.join(__dirname, '..', '.env'), 'utf8')
  .split('\n').forEach(line => {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  });

const SNAP = '/tmp/v1_snapshot_b7a.sqlite';
const T0 = '2026-06-26 16:18:33'; // B-2 이관 완료 커밋 b55985a 시각 (완료 상한)

// migrate-data.js가 id 보존해 이관한 19개 + EUL 특수 1개 = v1-유래 20개
const ID_PRESERVED = [
  'server_rooms', 'vendor_info', 'users', 'racks', 'module_inventory',
  'assets', 'ip_addresses', 'asset_ips', 'asset_credentials', 'photos',
  'computing_modules', 'power_nodes', 'network_connections',
  'vendor_intake_requests', 'lendings', 'lending_items', 'audit_logs',
  'module_inventory_logs', 'module_transfer_logs',
];
const EUL = 'equipment_usage_logs'; // id 미보존 (management_number→asset_id), 792→1036 이벤트 분할
const V1_ONLY = ['inventory_logs']; // v2 대응 테이블 없음
const V2_NATIVE = ['session', 'subnets']; // v2 자체 테이블

function colInfo(sq, table) {
  const cols = sq.prepare(`PRAGMA table_info(${table})`).all();
  return {
    names: cols.map(c => c.name),
    hasId: cols.some(c => c.name === 'id'),
    hasCreated: cols.some(c => c.name === 'created_at'),
    hasUpdated: cols.some(c => c.name === 'updated_at'),
  };
}

async function main() {
  const sq = new Database(SNAP, { readonly: true, fileMustExist: true });
  const pg = new Client({
    host: '127.0.0.1', port: 5433,
    database: process.env.POSTGRES_DB,
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
  });
  await pg.connect();

  const report = { T0, snapshot: SNAP, generatedFor: 'B-7a', tables: [], eul: null, v1Only: [], v2NativeTables: [], testPrefix: [] };

  // ── ID 보존 테이블 델타 ──
  for (const t of ID_PRESERVED) {
    const info = colInfo(sq, t);
    const v1Count = sq.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
    const v2Count = Number((await pg.query(`SELECT COUNT(*) c FROM ${t}`)).rows[0].c);

    const row = { table: t, v1Count, v2Count, hasCreated: info.hasCreated, hasUpdated: info.hasUpdated };

    // id 집합 비교 (신규/삭제 정밀 판정)
    const v1Ids = new Set(sq.prepare(`SELECT id FROM ${t}`).all().map(r => r.id));
    const v2Ids = new Set((await pg.query(`SELECT id FROM ${t}`)).rows.map(r => Number(r.id)));

    const v1NotInV2 = [...v1Ids].filter(id => !v2Ids.has(id));      // v1 신규 (이관 후 추가)
    const v2NotInV1 = [...v2Ids].filter(id => !v1Ids.has(id));      // v2 전용(네이티브) or v1삭제분
    const shared = [...v1Ids].filter(id => v2Ids.has(id));
    const v1OriginMaxId = shared.length ? Math.max(...shared) : 0;  // v1-유래 최대 id (이관 상한)

    row.setInsert = v1NotInV2.length;   // ★ 신규 권위값(집합차)
    row.v1OriginMaxId = v1OriginMaxId;

    // 신규 추정 ① created_at > T0
    if (info.hasCreated) {
      row.newByCreated = sq.prepare(`SELECT COUNT(*) c FROM ${t} WHERE created_at > ?`).get(T0).c;
    } else row.newByCreated = null;
    // 신규 추정 ② id > v1-유래 max(id)
    if (info.hasId) {
      row.newById = sq.prepare(`SELECT COUNT(*) c FROM ${t} WHERE id > ?`).get(v1OriginMaxId).c;
    } else row.newById = null;

    // 수정 추정: updated_at > T0 AND created_at <= T0 (이관분 중 변경)
    if (info.hasUpdated && info.hasCreated) {
      row.modified = sq.prepare(
        `SELECT COUNT(*) c FROM ${t} WHERE updated_at > ? AND created_at <= ?`
      ).get(T0, T0).c;
    } else if (info.hasUpdated) {
      row.modified = sq.prepare(`SELECT COUNT(*) c FROM ${t} WHERE updated_at > ?`).get(T0).c;
      row.modifiedNote = 'created_at 없음 — 상한만';
    } else {
      row.modified = null;
      row.modifiedNote = '판정불가 — updated_at 없음, 내용해시 비교 필요';
    }

    // 삭제 추정: v2에 있으나 v1 스냅샷에 없는 id 중 네이티브 제외
    // 네이티브 = created_at > T0. 삭제분 = v1-유래(created_at<=T0)인데 v1에서 사라짐.
    let deleted = 0, v2Native = 0;
    if (info.hasCreated && v2NotInV1.length) {
      const q = await pg.query(
        `SELECT (created_at > $1) AS native, COUNT(*) c FROM ${t} WHERE id = ANY($2::int[]) GROUP BY native`,
        [T0, v2NotInV1]
      );
      for (const r of q.rows) {
        if (r.native) v2Native += Number(r.c); else deleted += Number(r.c);
      }
    } else if (!info.hasCreated) {
      // created_at 없으면 네이티브/삭제 구분 불가 — 전부 미상으로
      row.deletedNote = 'created_at 없음 — 삭제/네이티브 구분 불가';
      deleted = v2NotInV1.length; // 상한
    }
    row.deleted = deleted;
    row.v2NativeById = v2Native;

    // STEP4: v2 네이티브(created_at > T0) 전체 건수
    if (info.hasCreated) {
      row.v2NativeByCreated = Number((await pg.query(`SELECT COUNT(*) c FROM ${t} WHERE created_at > $1`, [T0])).rows[0].c);
    } else row.v2NativeByCreated = null;

    report.tables.push(row);
  }

  // ── EUL 특수 처리 (행 수 직접 비교 금지) ──
  {
    const info = colInfo(sq, EUL);
    const v1Count = sq.prepare(`SELECT COUNT(*) c FROM ${EUL}`).get().c;
    const v2Count = Number((await pg.query(`SELECT COUNT(*) c FROM ${EUL}`)).rows[0].c);
    const v1NewByCreated = sq.prepare(`SELECT COUNT(*) c FROM ${EUL} WHERE created_at > ?`).get(T0).c;
    const v1Modified = sq.prepare(`SELECT COUNT(*) c FROM ${EUL} WHERE updated_at > ? AND created_at <= ?`).get(T0, T0).c;
    const v1MaxId = sq.prepare(`SELECT MAX(id) m FROM ${EUL}`).get().m;
    // v2 EUL 이벤트 분포 + 이벤트별 event_date > T0
    const v2Dist = (await pg.query(`SELECT event_type, COUNT(*) c FROM ${EUL} GROUP BY event_type ORDER BY event_type`)).rows;
    const v2CreatedAfterT0 = Number((await pg.query(`SELECT COUNT(*) c FROM ${EUL} WHERE created_at > $1`, [T0])).rows[0].c);
    report.eul = {
      table: EUL, note: 'B-2 이벤트소싱 변환(id 미보존, management_number→asset_id) — 행수 직접비교 금지',
      v1Count, v2Count, v1NewByCreated, v1Modified, v1MaxId,
      v2CreatedAfterT0, v2Dist,
      mappingMethod: 'migrate-eul.js: v1 id/created_at은 DEFAULT(미보존), assets.management_number→asset_id 매핑, 1행→다이벤트 분할',
    };
  }

  // ── v1 전용 테이블 ──
  for (const t of V1_ONLY) {
    const c = sq.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
    report.v1Only.push({ table: t, v1Count: c, note: 'v2 대응 테이블 없음(미이관)' });
  }

  // ── v2 네이티브 테이블 ──
  for (const t of V2_NATIVE) {
    try {
      const c = Number((await pg.query(`SELECT COUNT(*) c FROM ${t}`)).rows[0].c);
      report.v2NativeTables.push({ table: t, v2Count: c });
    } catch (e) { report.v2NativeTables.push({ table: t, error: e.message }); }
  }

  // ── STEP4: __TEST__ 접두 잔재 스캔 (텍스트 컬럼) ──
  const testTargets = [
    ['assets', ['management_number', 'asset_number', 'model_name']],
    ['server_rooms', ['name']],
    ['racks', ['name']],
    ['users', ['username', 'display_name']],
    ['module_inventory', ['label', 'item_code']],
    ['vendor_info', ['vendor_name']],
    ['equipment_usage_logs', ['user_name', 'test_name', 'management_number']],
  ];
  for (const [t, cols] of testTargets) {
    for (const col of cols) {
      try {
        const c = Number((await pg.query(`SELECT COUNT(*) c FROM ${t} WHERE ${col} LIKE '__TEST__%'`)).rows[0].c);
        if (c > 0) report.testPrefix.push({ table: t, col, count: c });
      } catch (e) { /* 컬럼 없으면 skip */ }
    }
  }

  await pg.end();
  sq.close();

  // ── 콘솔 출력 ──
  console.log('\n================ B-7a 델타 서베이 ================');
  console.log('T0(이관 완료 상한):', T0, '| 스냅샷:', SNAP, '\n');
  console.log('[ID 보존 20테이블 — 신규(집합차)/신규①created/신규②id/수정/삭제/v2네이티브]');
  const pad = (s, n) => String(s).padEnd(n);
  console.log(pad('table', 24), pad('v1', 6), pad('v2', 6), pad('신규', 5), pad('①cr', 5), pad('②id', 5), pad('수정', 6), pad('삭제', 5), 'v2네이티브');
  for (const r of report.tables) {
    console.log(
      pad(r.table, 24), pad(r.v1Count, 6), pad(r.v2Count, 6),
      pad(r.setInsert, 5),
      pad(r.newByCreated ?? '-', 5), pad(r.newById ?? '-', 5),
      pad(r.modified === null ? '판정불가' : r.modified, 6),
      pad(r.deleted, 5),
      String(r.v2NativeByCreated ?? '-')
    );
  }
  console.log('\n[EUL 특수]');
  console.log(JSON.stringify(report.eul, null, 2));
  console.log('\n[v1 전용(미이관)]', JSON.stringify(report.v1Only));
  console.log('[v2 네이티브 테이블]', JSON.stringify(report.v2NativeTables));
  console.log('[__TEST__ 접두 잔재]', report.testPrefix.length ? JSON.stringify(report.testPrefix) : '없음');

  require('fs').writeFileSync('/tmp/b7a_delta_survey.json', JSON.stringify(report, null, 2));
  console.log('\n→ /tmp/b7a_delta_survey.json 저장');
}
main().catch(e => { console.error('ERROR', e); process.exit(1); });
