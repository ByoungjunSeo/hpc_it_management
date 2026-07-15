// T3: 웹 BMC SOL 콘솔 — ws ↔ ipmitool sol activate 브릿지.
// 확정 결정: 관리자 한정 / BMC IP(ip_type='bmc') + BMC 자격증명(credential_type='bmc') /
//   비밀번호는 -E(IPMI_PASSWORD env)로 전달(argv 노출 회피) / 접속 전·종료 시 sol deactivate 보장 /
//   per-host 동시 1세션 / 전체·사용자당·유휴 제한 / audit(시작·종료·실패, 입출력 미기록) / resize 무시.
// T2 sshTerminal.js 골격(프레이밍/카운터/유휴/audit)을 복제 — 접속부만 ssh2 → child_process.spawn.
const url = require('url');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const AssetCredential = require('../models/assetCredential');
const AssetIp = require('../models/assetIp');
const Asset = require('../models/asset');
const AuditLog = require('../models/auditLog');

const WS_PATH = '/ws/sol-terminal';
const MAX_TOTAL = parseInt(process.env.SOL_TERM_MAX_TOTAL || '3', 10);
const MAX_PER_USER = parseInt(process.env.SOL_TERM_MAX_PER_USER || '1', 10);
const IDLE_MINUTES = parseInt(process.env.SOL_TERM_IDLE_MINUTES || '15', 10);
const IPMITOOL = process.env.IPMITOOL_BIN || 'ipmitool'; // 격리 검증 시 mock 주입용

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

// 비밀번호는 argv가 아니라 IPMI_PASSWORD env로만 전달(-E). deactivate/activate 공통.
function ipmiSpawn(host, user, pwEnv, tail) {
  return spawn(IPMITOOL, ['-I', 'lanplus', '-H', host, '-U', user, '-E', ...tail], { env: pwEnv });
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
  // 비밀번호는 이 스코프의 env 객체에만 존재(로그·audit·응답 미기록). deactivate까지 유지.
  const pwEnv = { ...process.env, IPMI_PASSWORD: cred.password || '' };

  active.add(meta);
  let closed = false;
  let child = null;
  let idleTimer = null;
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
    try { const d = ipmiSpawn(ip, cred.username, pwEnv, ['sol', 'deactivate']); d.on('error', () => {}); } catch (_) {}
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
  try { pre = ipmiSpawn(ip, cred.username, pwEnv, ['sol', 'deactivate']); }
  catch (err) { return startActivate(); }
  pre.on('error', () => { if (!closed && !child) startActivate(); });
  pre.on('close', () => { if (!closed && !child) startActivate(); });

  function startActivate() {
    if (closed) return;
    AuditLog.log(auditReq, { action: 'remote_sol_open', ...auditTarget, details: { host: ip, user: cred.username } });
    try {
      child = ipmiSpawn(ip, cred.username, pwEnv, ['sol', 'activate']);
    } catch (err) {
      send(ws, { type: 'error', message: 'SOL 실행 실패: ' + err.message });
      AuditLog.log(auditReq, { action: 'remote_sol_fail', ...auditTarget, details: { host: ip, user: cred.username, reason: err.message } });
      return cleanup('spawn_error');
    }
    resetIdle();
    let gotData = false;
    child.stdout.on('data', (d) => { gotData = true; resetIdle(); send(ws, { type: 'data', data: d.toString('utf8') }); });
    child.stderr.on('data', (d) => { send(ws, { type: 'data', data: d.toString('utf8') }); });
    child.on('error', (err) => {
      send(ws, { type: 'error', message: 'SOL 오류: ' + err.message });
      AuditLog.log(auditReq, { action: 'remote_sol_fail', ...auditTarget, details: { host: ip, user: cred.username, reason: err.message } });
      cleanup('child_error');
    });
    child.on('close', (code) => {
      // 데이터 한 번도 못 받고 비정상 종료 → 접속 실패로 간주(인증/도달 실패 등)
      if (code && code !== 0 && !gotData) {
        AuditLog.log(auditReq, { action: 'remote_sol_fail', ...auditTarget, details: { host: ip, user: cred.username, reason: 'ipmitool 종료코드 ' + code } });
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
