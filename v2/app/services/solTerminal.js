// T3: 웹 BMC SOL 콘솔 — ws ↔ ipmitool sol activate 브릿지.
// 확정 결정: 관리자 한정 / BMC IP(ip_type='bmc') + BMC 자격증명(credential_type='bmc') /
//   비밀번호는 -E(IPMI_PASSWORD env)로 전달(argv 노출 회피) / 접속 전·종료 시 sol deactivate 보장 /
//   per-host 동시 1세션 / 전체·사용자당·유휴 제한 / audit(시작·종료·실패, 입출력 미기록) / resize 무시.
// T2 sshTerminal.js 골격(프레이밍/카운터/유휴/audit)을 복제 — 접속부만 ssh2 → child_process.spawn.
const url = require('url');
const WebSocket = require('ws');
const AssetCredential = require('../models/assetCredential');
const AssetIp = require('../models/assetIp');
const Asset = require('../models/asset');
const AuditLog = require('../models/auditLog');
const ipmi = require('../utils/ipmi'); // SUX-6: 공통 호출(-E env, mock 주입)

const WS_PATH = '/ws/sol-terminal';
const MAX_TOTAL = parseInt(process.env.SOL_TERM_MAX_TOTAL || '3', 10);
const MAX_PER_USER = parseInt(process.env.SOL_TERM_MAX_PER_USER || '1', 10);
const IDLE_MINUTES = parseInt(process.env.SOL_TERM_IDLE_MINUTES || '15', 10);

// 활성 세션 추적: Set<{ userId, host }> — 카운트/호스트만(입출력 미보관)
const active = new Set();
function perUserCount(userId) { let n = 0; for (const s of active) if (s.userId === userId) n++; return n; }
function hostActive(host) { for (const s of active) if (s.host === host) return true; return false; }

// SOL 대상 해석: BMC IP(ip_type='bmc') + BMC 자격증명(credential_type='bmc').
function resolveBmc(ips, creds) {
  const ipRow = ips.find(i => i.ip_type === 'bmc');
  const cred = creds.find(c => c.credential_type === 'bmc');
  return { ip: (ipRow && ipRow.ip_address) || null, cred: cred || null };
}

function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// C: SOL 출력의 무해 잡음 필터(tty 없이 spawn 실행 시 흔함) — 사용자에게 안 보이게.
function scrubSol(text) {
  return text
    .split('\n')
    .filter(line => !/tcgetattr:\s*Inappropriate ioctl for device/i.test(line)
                 && !/tcsetattr:\s*Inappropriate ioctl for device/i.test(line))
    .join('\n');
}
// "SOL payload already active" 패턴(잔류 세션) 감지.
function isAlreadyActive(text) {
  return /SOL payload already active/i.test(text) || /already\s+active/i.test(text);
}

let _wss = null;
let _sessionMiddleware = null;
function init(sessionMiddleware) {
  _wss = new WebSocket.Server({ noServer: true });
  _sessionMiddleware = sessionMiddleware;
}

async function handleConnection(ws, ctx) {
  // ctx: { userId, username, userRole, remoteIp, assetId }
  if (active.size >= MAX_TOTAL) { send(ws, { type: 'error', message: '동시 접속 한도(전체 ' + MAX_TOTAL + ')를 초과했습니다.' }); return ws.close(); }
  if (perUserCount(ctx.userId) >= MAX_PER_USER) { send(ws, { type: 'error', message: '동시 접속 한도(사용자당 ' + MAX_PER_USER + ')를 초과했습니다.' }); return ws.close(); }

  const asset = await Asset.findById(ctx.assetId);
  if (!asset) { send(ws, { type: 'error', message: '자산을 찾을 수 없습니다.' }); return ws.close(); }
  const ips = await AssetIp.findByAsset(ctx.assetId);
  const creds = await AssetCredential.findByAsset(ctx.assetId); // 복호화된 password 포함(서버 내부)
  const { ip, cred } = resolveBmc(ips, creds);
  const label = asset.management_number || asset.model_name || ('asset#' + ctx.assetId);

  if (!ip) { send(ws, { type: 'error', message: '등록된 BMC IP가 없습니다.' }); return ws.close(); }
  if (!cred) { send(ws, { type: 'error', message: '등록된 BMC 자격증명이 없습니다.' }); return ws.close(); }
  // per-host 동시 1세션
  if (hostActive(ip)) { send(ws, { type: 'error', message: '해당 BMC에 이미 콘솔 세션이 있습니다.' }); return ws.close(); }

  const meta = { userId: ctx.userId, host: ip };
  const auditReq = { session: { userId: ctx.userId, username: ctx.username, userRole: ctx.userRole }, ip: ctx.remoteIp };
  const auditTarget = { targetType: 'asset', targetId: ctx.assetId, targetLabel: label };
  // 비밀번호는 이 스코프의 지역변수로만 존재(로그·audit·응답 미기록) — 공통 헬퍼가 env로 전달. deactivate까지 유지.
  const pw = cred.password || '';

  active.add(meta);
  let closed = false;
  let child = null;
  let idleTimer = null;
  let openLogged = false;   // remote_sol_open은 1회만(재시도 시 중복 방지)
  let retried = false;      // C: already-active 자동 재시도는 1회만
  let sawAlready = false;   // 안내 문구 판단
  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { send(ws, { type: 'error', message: '유휴 시간(' + IDLE_MINUTES + '분) 초과로 연결을 종료합니다.' }); cleanup('idle_timeout'); }, IDLE_MINUTES * 60 * 1000);
  };

  const cleanup = (reason) => {
    if (closed) return; closed = true;
    if (idleTimer) clearTimeout(idleTimer);
    active.delete(meta);
    try { if (child) child.kill('SIGTERM'); } catch (_) {}
    // 종료 보장: sol deactivate(잔류 세션 정리, 실패 무시). 비밀번호는 env로만.
    try { const d = ipmi.ipmiSpawn(ip, cred.username, pw, ['sol', 'deactivate']); d.on('error', () => {}); } catch (_) {}
    try { ws.close(); } catch (_) {}
    AuditLog.log(auditReq, { action: 'remote_sol_close', ...auditTarget, details: { host: ip, user: cred.username, reason } });
  };

  ws.on('close', () => cleanup('ws_closed'));
  ws.on('message', (raw) => {
    resetIdle();
    let msg; try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
    if (!child) return;
    if (msg.type === 'data' && typeof msg.data === 'string') { try { child.stdin.write(msg.data); } catch (_) {} }
    // resize 프레임은 수신하되 무시(직렬 콘솔 — 창 크기 개념 없음)
  });

  // 선제 sol deactivate 1회(잔류 세션 정리, 실패 무시) → activate
  let pre;
  try { pre = ipmi.ipmiSpawn(ip, cred.username, pw, ['sol', 'deactivate']); }
  catch (err) { return startActivate(); }
  pre.on('error', () => { if (!closed && !child) startActivate(); });
  pre.on('close', () => { if (!closed && !child) startActivate(); });

  function startActivate() {
    if (closed) return;
    if (!openLogged) { openLogged = true; AuditLog.log(auditReq, { action: 'remote_sol_open', ...auditTarget, details: { host: ip, user: cred.username } }); }
    try {
      child = ipmi.ipmiSpawn(ip, cred.username, pw, ['sol', 'activate']);
    } catch (err) {
      send(ws, { type: 'error', message: 'SOL 실행 실패: ' + err.message });
      AuditLog.log(auditReq, { action: 'remote_sol_fail', ...auditTarget, details: { host: ip, user: cred.username, reason: err.message } });
      return cleanup('spawn_error');
    }
    const thisChild = child;
    resetIdle();
    let gotData = false;
    let retryTriggered = false;
    const onOut = (buf) => {
      const raw = buf.toString('utf8');
      // C: 잔류 세션("already active") 텍스트는 콘솔로 흘리지 않는다(gotData로 오인 방지 → 안내 문구 보장).
      if (isAlreadyActive(raw)) {
        sawAlready = true;
        if (!gotData && !retried) {
          // 1회 자동 재시도(선제 deactivate → activate)
          retried = true; retryTriggered = true;
          send(ws, { type: 'warn', message: '다른 SOL 세션이 활성 상태입니다. 정리 후 재시도합니다...' });
          try { thisChild.kill('SIGTERM'); } catch (_) {}
          let d;
          try { d = ipmi.ipmiSpawn(ip, cred.username, pw, ['sol', 'deactivate']); }
          catch (e) { if (!closed) startActivate(); return; }
          d.on('error', () => { if (!closed) startActivate(); });
          d.on('close', () => { if (!closed) startActivate(); });
        }
        return; // already-active 텍스트는 data로 전달하지 않음
      }
      // C: tty 없는 spawn의 무해 잡음(tcgetattr 등) 필터
      const scrubbed = scrubSol(raw);
      if (scrubbed.length > 0) { gotData = true; resetIdle(); send(ws, { type: 'data', data: scrubbed }); }
    };
    child.stdout.on('data', onOut);
    child.stderr.on('data', onOut); // already-active/경고는 stderr로 오는 경우가 많음
    child.on('error', (err) => {
      if (retryTriggered) return;
      send(ws, { type: 'error', message: 'SOL 오류: ' + err.message });
      AuditLog.log(auditReq, { action: 'remote_sol_fail', ...auditTarget, details: { host: ip, user: cred.username, reason: err.message } });
      cleanup('child_error');
    });
    child.on('close', (code) => {
      if (retryTriggered) return; // 재시도 위해 우리가 kill한 close — 무시
      if (code && code !== 0 && !gotData) {
        const reason = sawAlready ? 'SOL payload already active' : ('ipmitool 종료코드 ' + code);
        AuditLog.log(auditReq, { action: 'remote_sol_fail', ...auditTarget, details: { host: ip, user: cred.username, reason } });
        if (sawAlready) send(ws, { type: 'error', message: '다른 SOL 세션이 활성 상태입니다. 잠시 후 재시도하거나 관리자에게 문의하세요.' });
      }
      send(ws, { type: 'exit', code: code || 0 });
      cleanup('sol_closed');
    });
  }
}

// 경로 검증은 호출측(server.js)에서 완료. 세션·관리자 검증 후 handleConnection.
function handleUpgrade(req, socket, head) {
  if (!_wss) { socket.destroy(); return; }
  const parsed = url.parse(req.url, true);
  _sessionMiddleware(req, {}, () => {
    const sess = req.session;
    if (!sess || !sess.userId || sess.userRole !== 'admin') { socket.destroy(); return; }
    const assetId = parseInt(parsed.query.assetId, 10);
    if (!assetId) { socket.destroy(); return; }
    const remoteIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    _wss.handleUpgrade(req, socket, head, (ws) => {
      handleConnection(ws, { userId: sess.userId, username: sess.username, userRole: sess.userRole, remoteIp, assetId })
        .catch(err => { try { send(ws, { type: 'error', message: '내부 오류: ' + err.message }); ws.close(); } catch (_) {} });
    });
  });
}

module.exports = { init, handleUpgrade, resolveBmc, WS_PATH };
