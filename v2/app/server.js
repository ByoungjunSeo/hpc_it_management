require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

// BL-9: SESSION_SECRET 기동 검사 — docker/systemd 어느 경로로 기동해도 여기서 걸린다.
// 구 fallback 리터럴은 제거(검사 우회 경로 오해 방지). 아래 목록은 차단 비교용으로만 보존.
const LEGACY_SESSION_FALLBACKS = ['it-asset-secret', 'it-asset-secret-key'];
const sessionSecret = process.env.SESSION_SECRET || '';
if (!sessionSecret || sessionSecret.startsWith('CHANGE_ME')
    || LEGACY_SESSION_FALLBACKS.includes(sessionSecret) || sessionSecret.length < 32) {
  console.error('[session-secret] 오류: SESSION_SECRET이 미설정이거나 안전하지 않습니다 (미설정/CHANGE_ME/과거 기본값/32자 미만).');
  console.error('[session-secret] .env의 SESSION_SECRET을 32자 이상 무작위 문자열로 설정한 뒤 다시 시작하세요. 생성 예: openssl rand -hex 32');
  process.exit(1);
}

// BL-11: CREDENTIAL_ENCRYPTION_KEY 형식 검사 — 설정됐는데 형식이 틀리면(hex 64자 아님)
// 잘못된 키로 기동해 자격증명 복호화가 전부 깨지는 것을 방지. 미설정은 허용(자격증명 기능
// 미사용 설치 대비) 하되 경고 — 실제 암호문 복호화 시점에 credentialCrypto가 명확히 실패시킨다.
const credKey = process.env.CREDENTIAL_ENCRYPTION_KEY || '';
if (credKey && !/^[0-9a-fA-F]{64}$/.test(credKey)) {
  console.error('[credential-key] 오류: CREDENTIAL_ENCRYPTION_KEY 형식 오류 — hex 64자(32바이트)여야 합니다. 생성: openssl rand -hex 32');
  process.exit(1);
} else if (!credKey) {
  console.warn('[credential-key] 경고: CREDENTIAL_ENCRYPTION_KEY 미설정 — 장비 자격증명 저장/조회 기능 사용 시 .env에 설정 필요(openssl rand -hex 32).');
}

const express = require('express');
const path = require('path');
const fs = require('fs');
const morgan = require('morgan');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const flash = require('express-flash');
const cookieParser = require('cookie-parser');
const appConfig = require('./config/app');
const { pool, closeDb } = require('./config/database');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const { requireLogin, requireMaintenance } = require('./middleware/auth');

// Ensure photo upload directories exist
const photoAssetsDir = path.join(__dirname, 'public', 'uploads', 'photos', 'assets');
const photoModulesDir = path.join(__dirname, 'public', 'uploads', 'photos', 'modules');
const photoLendingsDir = path.join(__dirname, 'public', 'uploads', 'photos', 'lendings');
[photoAssetsDir, photoModulesDir, photoLendingsDir].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const app = express();

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Middleware
app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser(sessionSecret));
// T2: 세션 미들웨어를 변수로 추출 — ws upgrade 핸들러에서 동일 세션 파싱·인증 재사용.
const sessionMiddleware = session({
  store: new pgSession({
    pool: pool,
    tableName: 'session',
  }),
  name: 'itassets_v2.sid', // B-6b-fix: v1(:3000)과 쿠키명 분리 — 기본 connect.sid 공유 시 상호 로그아웃
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
});
app.use(sessionMiddleware);
app.use(flash());
app.use(express.static(path.join(__dirname, 'public')));

// Flash messages + current user available to all views
app.use((req, res, next) => {
  res.locals.flash = {
    success: req.flash('success')[0],
    error: req.flash('error')[0]
  };
  res.locals.appConfig = appConfig;
  res.locals.currentUser = req.session.userId ? {
    id: req.session.userId,
    username: req.session.username,
    role: req.session.userRole,
    displayName: req.session.displayName
  } : null;
  next();
});

// ── Routes ──────────────────────────────────────────────────

// Auth routes (no login required)
app.use('/', require('./routes/auth'));

// Public intake (no login required - external vendor use)
// app.use('/intake', require('./routes/publicIntake'));

// All other routes require login
app.use(requireLogin);

app.use('/api/photos', require('./routes/photos'));
app.use('/', require('./routes/index'));
app.use('/assets', require('./routes/assets'));
app.use('/rooms', require('./routes/serverRooms'));
app.use('/racks', require('./routes/racks'));
app.use('/computing-modules', (req, res) => res.redirect('/module-inventory?tab=installed'));
app.use('/ip-management', require('./routes/ipManagement'));
app.use('/inventory-audit', require('./routes/inventoryAudit')); // BL-12: /inventory 앞에 마운트(경로 우선)
app.use('/inventory', require('./routes/inventory'));
app.use('/discovery', require('./routes/discovery'));
app.use('/offices', require('./routes/offices'));
app.use('/storage', require('./routes/storage'));
app.use('/lendings', require('./routes/lendings'));
app.use('/module-inventory', require('./routes/moduleInventory'));
app.use('/vendor-intake', require('./routes/vendorIntake'));
// app.use('/requests', require('./routes/requests'));
// app.use('/excel', require('./routes/excelUpload'));
// app.use('/power-panel', require('./routes/powerPanel'));
// app.use('/network-layout', require('./routes/networkLayout'));
app.use('/audit-log', requireMaintenance, require('./routes/auditLog')); // v2.4.1: 이력관리는 maintenance 이상(viewer 차단)
app.use('/backups', require('./routes/backups')); // T4: 백업 관리(관리자 한정)
// app.use('/gpu-monitoring', require('./routes/gpuMonitoring'));
// app.use('/chat', require('./routes/chat'));

// Global search API
app.get('/api/search', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q || q.length < 2) return res.json([]);
    const like = '%' + q + '%';
    const results = [];

    // B-4b: 선택 room_id → 해당 서버실 소속 자산으로 한정(랙 배치 + 블레이드는 부모 섀시 랙 기준 + 직접 room_id 미배치).
    //   매칭 로직(아래 쿼리 WHERE)은 전역과 동일, room 소속 여부만 AND로 덧붙인다(로직 복제 없음).
    let roomIds = null;
    const roomId = parseInt(req.query.room_id, 10);
    if (req.query.room_id != null && req.query.room_id !== '') {
      if (!roomId) return res.json([]);   // 숫자 아님 → 빈 결과(오류 아님)
      const { rows: rids } = await pool.query(`
        SELECT a.id FROM assets a
        LEFT JOIN racks r ON a.rack_id = r.id
        LEFT JOIN assets p ON a.parent_asset_id = p.id
        LEFT JOIN racks pr ON p.rack_id = pr.id
        WHERE COALESCE(r.room_id, pr.room_id, a.room_id) = $1
      `, [roomId]);
      roomIds = rids.map(r => r.id);
      if (!roomIds.length) return res.json([]);   // 없는/빈 서버실 → 빈 결과
    }

    // [장비] 자산 이름/번호/시리얼/담당자/용도/제조사 + 레거시 ip (자격증명 컬럼 미포함). cap 15.
    const assetParams = roomIds ? [like, roomIds] : [like];
    const { rows: assets } = await pool.query(`
      SELECT a.id, a.asset_number, a.management_number, a.model_name, a.asset_type, a.ip_address, a.assigned_user
      FROM assets a
      WHERE (a.asset_number ILIKE $1 OR a.management_number ILIKE $1 OR a.model_name ILIKE $1
         OR a.ip_address ILIKE $1 OR a.assigned_user ILIKE $1 OR a.purpose ILIKE $1
         OR a.serial_number ILIKE $1 OR a.manufacturer ILIKE $1)
      ${roomIds ? 'AND a.id = ANY($2::int[])' : ''}
      LIMIT 15
    `, assetParams);
    assets.forEach(a => {
      results.push({ type: 'asset', matchType: 'asset', id: a.id, asset_type: a.asset_type,
        title: a.model_name || a.asset_number || a.asset_type,
        subtitle: [a.management_number, a.asset_number, a.ip_address, a.assigned_user].filter(Boolean).join(' | '),
        url: '/assets/' + a.id });
    });

    // [IP] asset_ips 전체(BMC/IB/data/OS 포함). 자산 미매칭분만. cap 10.
    const ipParams = roomIds ? [like, roomIds] : [like];
    const { rows: ipRows } = await pool.query(`
      SELECT DISTINCT a.id, a.model_name, a.asset_number, a.management_number, a.asset_type, ai.ip_address
      FROM asset_ips ai JOIN assets a ON ai.asset_id = a.id
      WHERE (ai.ip_address ILIKE $1 OR ai.description ILIKE $1)
      ${roomIds ? 'AND a.id = ANY($2::int[])' : ''}
      LIMIT 10
    `, ipParams);
    ipRows.forEach(ip => {
      if (results.find(r => r.id === ip.id)) return;
      results.push({ type: 'ip', matchType: 'ip', id: ip.id, asset_type: ip.asset_type,
        title: ip.model_name || ip.management_number || ip.asset_type,
        subtitle: [ip.management_number, ip.ip_address].filter(Boolean).join(' | '),
        url: '/assets/' + ip.id });
    });

    // [모듈 장착 장비] B-4: 유형키워드/정규화/숫자경계 매칭 → 자산 단위 묶음 + matchedModules 요약
    const ql = q.toLowerCase();
    const TYPEKW = { gpu:'gpu', npu:'npu', cpu:'cpu', memory:'memory', '메모리':'memory', ram:'memory', dimm:'memory',
      nic:'network', network:'network', '네트워크':'network', '랜카드':'network',
      disk:'disk', '디스크':'disk', ssd:'disk', nvme:'disk', hdd:'disk', raid:'raid', psu:'psu', '파워':'psu' };
    const normq = ql.replace(/\s+/g, '').replace(/gib/g, 'gb').replace(/tib/g, 'tb');
    const NORMF = "regexp_replace(regexp_replace(regexp_replace(lower(coalesce(cm.model,'')||' '||coalesce(cm.capacity,'')||' '||coalesce(cm.manufacturer,'')||' '||coalesce(cm.specification,'')),'gib','gb','g'),'tib','tb','g'),'\\s+','','g')";
    let modWhere, modParams;
    if (TYPEKW[ql]) { modWhere = 'cm.module_type = $1'; modParams = [TYPEKW[ql]]; }
    else if (/^\d+$/.test(normq)) { const NORMCAP = "regexp_replace(regexp_replace(regexp_replace(lower(coalesce(cm.capacity,'')),'gib','gb','g'),'tib','tb','g'),'\\s+','','g')"; modWhere = NORMCAP + " ~ ('(^|[^0-9])' || $1 || '([^0-9]|$)')"; modParams = [normq]; }
    else { modWhere = '(' + NORMF + " LIKE '%'||$1||'%' OR lower(cm.model) LIKE '%'||$2||'%' OR lower(cm.manufacturer) LIKE '%'||$2||'%')"; modParams = [normq, ql]; }
    if (roomIds) { modParams.push(roomIds); modWhere = '(' + modWhere + ') AND cm.asset_id = ANY($' + modParams.length + '::int[])'; }
    const { rows: modRows } = await pool.query(
      `SELECT cm.asset_id, cm.module_type, cm.model, cm.manufacturer, cm.capacity, cm.count, cm.owner, cm.owner_vendor_id,
              v.vendor_name AS owner_vendor_name, a.model_name, a.management_number, a.asset_number, a.asset_type
       FROM computing_modules cm JOIN assets a ON cm.asset_id = a.id LEFT JOIN vendor_info v ON cm.owner_vendor_id = v.id
       WHERE ${modWhere} ORDER BY cm.asset_id, cm.module_type`, modParams);
    const modByAsset = {};
    modRows.forEach(m => { (modByAsset[m.asset_id] = modByAsset[m.asset_id] || []).push(m); });
    function summarize(mods) {
      const map = {};
      mods.forEach(m => { const k = m.module_type + '|' + (m.model || '') + '|' + (m.capacity || '') + '|' + m.owner;
        if (!map[k]) map[k] = { module_type: m.module_type, model: m.model || '', capacity: m.capacity || '', owner: m.owner, owner_vendor_name: m.owner_vendor_name, count: 0 };
        map[k].count += (m.count || 1); });
      const arr = Object.values(map);
      return { lines: arr.slice(0, 3), extra: Math.max(0, arr.length - 3) };
    }
    let modAssetAdded = 0;
    Object.keys(modByAsset).forEach(aid => {
      const summary = summarize(modByAsset[aid]);
      const existing = results.find(r => r.id == aid);
      if (existing) { existing.matchedModules = summary; return; }   // 이미 결과에 있어도 요약 부착
      if (modAssetAdded >= 50) return;                               // 모듈 구역 cap 50
      modAssetAdded++;
      const first = modByAsset[aid][0];
      results.push({ type: 'module', matchType: 'module', id: parseInt(aid, 10), asset_type: first.asset_type,
        title: first.model_name || first.asset_number || first.asset_type,
        subtitle: [first.management_number, first.asset_number].filter(Boolean).join(' | '),
        url: '/assets/' + aid, matchedModules: summary });
    });

    // B-4b #3: [장비] 구역 노이즈 완화 — 단어 경계 일치를 부분 일치보다 앞으로(안정 정렬, 제외는 안 함).
    //   예) "a100" → A100(경계)이 PA1000/A1004NS(부분)보다 위. 모듈/IP 구역 순서는 불변.
    if (!TYPEKW[ql] && !/^\d+$/.test(normq)) {
      const esc = ql.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const boundary = new RegExp('(^|[^a-z0-9])' + esc + '([^a-z0-9]|$)', 'i');
      const rankOf = r => (boundary.test(r.title || '') || boundary.test(r.subtitle || '')) ? 0 : 1;
      const aSec = results.filter(r => r.matchType === 'asset');
      if (aSec.length > 1) {
        const rest = results.filter(r => r.matchType !== 'asset');
        aSec.sort((x, y) => rankOf(x) - rankOf(y));   // Array.sort는 안정 정렬(Node) → 동순위 원순서 유지
        results.length = 0; results.push(...aSec, ...rest);
      }
    }

    // UX-3(F3): 결과 자산들의 위치 일괄 조회 — 본인 랙 또는 부모 섀시(블레이드) 랙 기준.
    //   locateUrl = 랙 배치면 /rooms?focus=<id>, 아니면 null. location/currentLocation 문자열 부착.
    const ids = [...new Set(results.map(r => r.id))];
    if (ids.length) {
      const { rows: locs } = await pool.query(`
        SELECT a.id, a.status, a.asset_type,
               COALESCE(a.rack_id, p.rack_id) AS eff_rack_id,
               COALESCE(a.rack_unit_start, p.rack_unit_start) AS eff_u,
               COALESCE(sr.name, psr.name) AS room_name,
               COALESCE(sr.location_type, psr.location_type) AS eff_room_type,
               COALESCE(r.name, pr.name) AS rack_name,
               dr.name AS direct_room_name
        FROM assets a
        LEFT JOIN assets p ON a.parent_asset_id = p.id
        LEFT JOIN racks r ON a.rack_id = r.id
        LEFT JOIN server_rooms sr ON r.room_id = sr.id
        LEFT JOIN racks pr ON p.rack_id = pr.id
        LEFT JOIN server_rooms psr ON pr.room_id = psr.id
        LEFT JOIN server_rooms dr ON a.room_id = dr.id
        WHERE a.id = ANY($1::int[])
      `, [ids]);
      const statusMap = { active: '운영중', inactive: '비활성', maintenance: '점검중', decommissioned: '폐기', returned: '반납' };
      const locMap = {};
      locs.forEach(l => {
        const uLabel = l.eff_u ? ('U' + (Math.floor((l.eff_u - 1) / 3) + 1)) : '';
        const placed = !!l.eff_rack_id;
        // B-4b 1-3: /rooms는 location_type='server_room'만 렌더 → 그 외(사무실 등) 랙 자산은 focus 이동이 실패하므로 locateUrl=null(상세로).
        const locatable = placed && l.eff_room_type === 'server_room';
        locMap[l.id] = {
          placed,
          location: placed ? [l.room_name, l.rack_name].filter(Boolean).join(' > ') + (uLabel ? (' ' + uLabel) : '')
                           : (l.direct_room_name || ''),
          currentLocation: placed ? null
                           : ((l.direct_room_name ? (l.direct_room_name + ' ') : '') + '(' + (statusMap[l.status] || l.status || '-') + ')'),
          locateUrl: locatable ? ('/rooms?focus=' + l.id) : null,
          status: l.status
        };
      });
      results.forEach(r => {
        const m = locMap[r.id] || {};
        r.location = m.location || '';
        r.locateUrl = m.locateUrl || null;
        r.currentLocation = m.currentLocation || null;
        r.status = m.status || null;   // B-5c: 결과 자산 자신의 status(패널 상태 필터용; locs는 a.status=자신 값)
      });
    }

    res.json(results.slice(0, 80));   // 구역별 cap(장비15/IP10/모듈50) 이후 안전 상한
  } catch (err) {
    console.error('[/api/search] Error:', err.message);
    res.json([]);
  }
});

// Error handling
app.use(notFoundHandler);
app.use(errorHandler);

// B-6e-fix: 미처리 async rejection이 프로세스를 죽이지 않게 안전망.
// (node18은 unhandledRejection 시 기본적으로 프로세스를 종료 — 라우트 하나의 미처리
//  reject가 전체 서비스 다운으로 번지는 것을 막는다. 로그만 남기고 생존.)
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason && reason.stack ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err && err.stack ? err.stack : err);
});

// Start server — T2: http.createServer 경유(ws upgrade 부착 위해)
const http = require('http');
const server = http.createServer(app);

// T2/T3: 웹 콘솔 ws — 단일 upgrade 디스패처가 경로별로 분기(SSH·SOL 공존, 그 외 소켓 종료).
const sshTerminal = require('./services/sshTerminal');
const solTerminal = require('./services/solTerminal');
sshTerminal.init(sessionMiddleware);
solTerminal.init(sessionMiddleware);
server.on('upgrade', (req, socket, head) => {
  let pathname;
  try { pathname = require('url').parse(req.url).pathname; } catch (_) { socket.destroy(); return; }
  if (pathname === sshTerminal.WS_PATH) return sshTerminal.handleUpgrade(req, socket, head);
  if (pathname === solTerminal.WS_PATH) return solTerminal.handleUpgrade(req, socket, head);
  socket.destroy();
});

// BUG-12: 기동 시 스키마 자체점검 — 오래된/불완전 스키마(예: 재설치 시 남은 pgdata 볼륨)로
// 인한 런타임 "column ... does not exist" 혼란을 기동 단계의 명확한 진단으로 바꾼다.
// DB 미도달은 무시(pool이 별도 처리), 컬럼이 '확실히' 없을 때만 안내(경고 — 기동은 유지).
async function schemaSelfCheck() {
  const REQUIRED = [
    ['asset_credentials', 'password_enc'], // BL-11
    ['assets', 'node_index'],              // BUG-10
    ['lending_items', 'returned_quantity'] // BL-13
  ];
  try {
    const { rows } = await pool.query(
      `SELECT table_name || '.' || column_name AS c FROM information_schema.columns WHERE table_schema='public'`);
    const have = new Set(rows.map(r => r.c));
    const missing = REQUIRED.filter(([t, c]) => !have.has(t + '.' + c)).map(([t, c]) => t + '.' + c);
    if (missing.length) {
      console.error('[schema] ⚠ DB 스키마가 최신이 아닙니다 — 누락 컬럼: ' + missing.join(', '));
      console.error('[schema]   신규 설치인데 이 경고가 보이면 pgdata 볼륨에 이전(오래된) 스키마가 남은 것입니다.');
      console.error('[schema]   → 신규 설치: `docker compose -f docker-compose.prod.yml down -v` 후 재기동(데이터 삭제 주의).');
      console.error('[schema]   → 업그레이드: DEPLOY.md §6 마이그레이션(db/migrations/*.sql)을 순서대로 적용.');
    }
  } catch (e) {
    // DB 미도달/권한 등 — 자체점검은 진단용이므로 기동을 막지 않는다.
    console.warn('[schema] 자체점검 건너뜀(DB 조회 실패): ' + (e.code || e.message));
  }
}
schemaSelfCheck();

const PORT = process.env.APP_PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`IT Asset Management v2 running on http://0.0.0.0:${PORT}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  closeDb();
  process.exit(0);
});

process.on('SIGTERM', () => {
  closeDb();
  process.exit(0);
});

module.exports = app;
