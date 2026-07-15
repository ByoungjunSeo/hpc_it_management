// T2: 웹 SSH 터미널 — ws ↔ ssh2 shell 브릿지.
// 확정 결정: 관리자 한정 / 서버 내부 복호화 직결(브라우저 미전송) / TOFU(경고만) /
//   동시세션(전체·사용자당)·유휴 타임아웃 / keepalive / audit(시작·종료·실패, 입출력 미기록).
const crypto = require('crypto');
const url = require('url');
const WebSocket = require('ws');
const { Client } = require('ssh2');
const { pool } = require('../config/database');
const AssetCredential = require('../models/assetCredential');
const AssetIp = require('../models/assetIp');
const Asset = require('../models/asset');
const AuditLog = require('../models/auditLog');

const WS_PATH = '/ws/ssh-terminal';
const MAX_TOTAL = parseInt(process.env.SSH_TERM_MAX_TOTAL || '5', 10);
const MAX_PER_USER = parseInt(process.env.SSH_TERM_MAX_PER_USER || '2', 10);
const IDLE_MINUTES = parseInt(process.env.SSH_TERM_IDLE_MINUTES || '15', 10);

// 활성 세션 추적: Set<{ userId }> — 카운트만(입출력 미보관)
const active = new Set();
function perUserCount(userId) {
  let n = 0; for (const s of active) if (s.userId === userId) n++; return n;
}

// §1-9: SSH 대상 IP — os 우선 → mgmt 제외 첫 IP → 나머지. 포트는 ssh_port → 22.
function resolveTarget(asset, ips) {
  const os = ips.find(i => i.ip_type === 'os');
  const nonMgmt = ips.find(i => i.ip_type !== 'management' && i.ip_type !== 'bmc');
  const any = ips[0];
  const ip = (os && os.ip_address) || (nonMgmt && nonMgmt.ip_address) || (any && any.ip_address) || asset.ip_address || null;
  const port = asset.ssh_port || 22;
  return { ip, port };
}

// SSH 자격증명 정책 (credential_type 저장값 기준: 'root'/'user'/'bmc'/'os'/'etc').
// BMC/IPMI는 SSH 후보에서 항상 제외 — 전원/SOL(IPMI) 영역이며 SSH 셸 대상이 아니다(T3 SOL 트랙).
// ('ipmi'는 현행 스키마 CHECK에 없으나 방어적으로 함께 제외.)
const SSH_EXCLUDED_TYPES = ['bmc', 'ipmi'];
// 자동 선택 우선순위: root → os. 그 외(user/etc)는 자동 선택 후보에서 제외(수동 선택은 라우트에서 허용).
const SSH_AUTO_PRIORITY = ['root', 'os'];

function resolveCredential(creds, credId) {
  if (credId) {
    const c = creds.find(x => String(x.id) === String(credId));
    if (!c || SSH_EXCLUDED_TYPES.includes(c.credential_type)) return null; // BMC/IPMI는 수동으로도 불가
    return c;
  }
  const usable = creds.filter(c => !SSH_EXCLUDED_TYPES.includes(c.credential_type));
  for (const t of SSH_AUTO_PRIORITY) {
    const hit = usable.find(c => c.credential_type === t);
    if (hit) return hit;
  }
  return null; // root/os 없으면 자동 선택 0 (프론트는 단일/복수 시 credId를 명시 전달)
}

function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// TOFU: 호스트키 지문 조회·저장. 불일치면 {mismatch:true} — 차단 아님(경고만).
async function tofuCheck(host, port, keyBuf) {
  const fingerprint = crypto.createHash('sha256').update(keyBuf).digest('base64');
  let key_type = 'ssh';
  try { const p = require('ssh2').utils.parseKey(keyBuf); if (p && !(p instanceof Error) && p.type) key_type = p.type; } catch (_) {}
  const { rows } = await pool.query('SELECT fingerprint FROM ssh_host_keys WHERE host=$1 AND port=$2', [host, port]);
  if (!rows[0]) {
    await pool.query('INSERT INTO ssh_host_keys (host, port, key_type, fingerprint) VALUES ($1,$2,$3,$4) ON CONFLICT (host,port) DO NOTHING', [host, port, key_type, fingerprint]);
    return { firstSeen: true, mismatch: false };
  }
  await pool.query('UPDATE ssh_host_keys SET last_seen=now() WHERE host=$1 AND port=$2', [host, port]);
  return { firstSeen: false, mismatch: rows[0].fingerprint !== fingerprint };
}

function auditLike(session, remoteIp) {
  return { session, ip: remoteIp };
}

async function handleConnection(ws, ctx) {
  // ctx: { userId, username, userRole, remoteIp, assetId, credId }
  const meta = { userId: ctx.userId };
  // 동시 세션 제한
  if (active.size >= MAX_TOTAL) { send(ws, { type: 'error', message: '동시 접속 한도(전체 ' + MAX_TOTAL + ')를 초과했습니다.' }); return ws.close(); }
  if (perUserCount(ctx.userId) >= MAX_PER_USER) { send(ws, { type: 'error', message: '동시 접속 한도(사용자당 ' + MAX_PER_USER + ')를 초과했습니다.' }); return ws.close(); }

  const asset = await Asset.findById(ctx.assetId);
  if (!asset) { send(ws, { type: 'error', message: '자산을 찾을 수 없습니다.' }); return ws.close(); }
  const ips = await AssetIp.findByAsset(ctx.assetId);
  const creds = await AssetCredential.findByAsset(ctx.assetId); // 복호화된 password 포함(서버 내부)
  const { ip, port } = resolveTarget(asset, ips);
  const cred = resolveCredential(creds, ctx.credId);
  const label = asset.management_number || asset.model_name || ('asset#' + ctx.assetId);

  if (!ip) { send(ws, { type: 'error', message: '접속 가능한 IP가 없습니다.' }); return ws.close(); }
  if (!cred) { send(ws, { type: 'error', message: '등록된 SSH 자격증명이 없습니다.' }); return ws.close(); }

  const auditTarget = { targetType: 'asset', targetId: ctx.assetId, targetLabel: label };
  const auditReq = auditLike({ userId: ctx.userId, username: ctx.username, userRole: ctx.userRole }, ctx.remoteIp);

  active.add(meta);
  let closed = false;
  let idleTimer = null;
  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { send(ws, { type: 'error', message: '유휴 시간(' + IDLE_MINUTES + '분) 초과로 연결을 종료합니다.' }); cleanup('idle_timeout'); }, IDLE_MINUTES * 60 * 1000);
  };
  const conn = new Client();
  let stream = null;
  const cleanup = (reason) => {
    if (closed) return; closed = true;
    if (idleTimer) clearTimeout(idleTimer);
    active.delete(meta);
    try { if (stream) stream.end(); } catch (_) {}
    try { conn.end(); } catch (_) {}
    try { ws.close(); } catch (_) {}
    AuditLog.log(auditReq, { action: 'remote_ssh_close', ...auditTarget, details: { host: ip, port, user: cred.username, reason } });
  };

  ws.on('close', () => cleanup('ws_closed'));
  ws.on('message', (raw) => {
    resetIdle();
    let msg; try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
    if (!stream) return;
    if (msg.type === 'data' && typeof msg.data === 'string') stream.write(msg.data);
    else if (msg.type === 'resize') stream.setWindow(msg.rows || 24, msg.cols || 80, 0, 0);
  });

  // TOFU: connect 전에 host 지문 검증은 hostVerifier 콜백에서
  let tofuWarn = false;
  conn.on('ready', () => {
    if (tofuWarn) send(ws, { type: 'warn', message: '경고: 이 호스트의 SSH 키가 이전 기록과 다릅니다(TOFU 불일치). 접속은 진행됩니다.' });
    AuditLog.log(auditReq, { action: 'remote_ssh_open', ...auditTarget, details: { host: ip, port, user: cred.username } });
    conn.shell({ term: 'xterm-256color' }, (err, sh) => {
      if (err) { send(ws, { type: 'error', message: 'shell 열기 실패: ' + err.message }); return cleanup('shell_error'); }
      stream = sh;
      resetIdle();
      sh.on('data', (d) => { resetIdle(); send(ws, { type: 'data', data: d.toString('utf8') }); });
      sh.stderr.on('data', (d) => send(ws, { type: 'data', data: d.toString('utf8') }));
      sh.on('close', (code) => { send(ws, { type: 'exit', code: code || 0 }); cleanup('shell_closed'); });
    });
  });
  conn.on('error', (err) => {
    const m = (err && err.message || '').toLowerCase();
    const reason = /auth|password|permission|denied/.test(m) ? '인증 실패' : /timeout|timed out|refused|unreachable|host/.test(m) ? '접속 실패(도달 불가/타임아웃)' : ('연결 오류: ' + (err && err.message));
    send(ws, { type: 'error', message: reason });
    AuditLog.log(auditReq, { action: 'remote_ssh_fail', ...auditTarget, details: { host: ip, port, user: cred.username, reason } });
    cleanup('ssh_error');
  });

  // 접속 시도 — 복호화 비밀번호는 이 스코프 지역변수, 접속 후 참조 해제
  let pw = cred.password || '';
  conn.connect({
    host: ip, port, username: cred.username, password: pw,
    readyTimeout: 15000,
    keepaliveInterval: 30000, keepaliveCountMax: 3,
    hostVerifier: (keyBuf, cb) => {
      tofuCheck(ip, port, keyBuf).then(r => { tofuWarn = r.mismatch; cb(true); }).catch(() => cb(true));
    }
  });
  pw = null; // 참조 해제(ssh2가 내부 복사본 보유)
}

// T3: 단일 upgrade 디스패처(server.js)가 경로별로 handleUpgrade를 호출한다.
// (SSH·SOL이 각자 server.on('upgrade')를 걸면 상대 경로 소켓을 destroy하는 충돌이 생기므로 분리.)
let _wss = null;
let _sessionMiddleware = null;
function init(sessionMiddleware) {
  _wss = new WebSocket.Server({ noServer: true });
  _sessionMiddleware = sessionMiddleware;
}

// 경로 검증은 호출측(server.js)에서 완료. 세션·관리자 검증 후 handleConnection.
function handleUpgrade(req, socket, head) {
  if (!_wss) { socket.destroy(); return; }
  const parsed = url.parse(req.url, true);
  _sessionMiddleware(req, {}, () => {
    const sess = req.session;
    if (!sess || !sess.userId || sess.userRole !== 'admin') { socket.destroy(); return; } // 인증 실패는 조용히 거절
    const assetId = parseInt(parsed.query.assetId, 10);
    const credId = parsed.query.credId ? parseInt(parsed.query.credId, 10) : null;
    if (!assetId) { socket.destroy(); return; }
    const remoteIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    _wss.handleUpgrade(req, socket, head, (ws) => {
      handleConnection(ws, { userId: sess.userId, username: sess.username, userRole: sess.userRole, remoteIp, assetId, credId })
        .catch(err => { try { send(ws, { type: 'error', message: '내부 오류: ' + err.message }); ws.close(); } catch (_) {} });
    });
  });
}

module.exports = { init, handleUpgrade, resolveTarget, resolveCredential, WS_PATH, SSH_EXCLUDED_TYPES, SSH_AUTO_PRIORITY };
