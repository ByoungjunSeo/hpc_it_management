// T4: 백업 관리 — docker exec pg_dump(-Fc)로 DB 덤프 생성/목록/삭제/회전 + uploads tar(옵션).
// 셸 경유 없음(spawn/execFile 인자 배열 — 인젝션 방지). 저장은 v2/backups/db/ (public 아님).
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

// 컨테이너명은 신규 env. 코드 기본값은 compose 표준명(it-assets-db-1). 이 서버 .env엔 it-assets-db 지정.
const DB_CONTAINER = process.env.DB_CONTAINER_NAME || 'it-assets-db-1';
const KEEP = Math.max(1, parseInt(process.env.BACKUP_KEEP_COUNT || '14', 10));
const PGUSER = process.env.POSTGRES_USER || 'itadmin';
const PGDB = process.env.POSTGRES_DB || 'it_assets';
const TIMEOUT_MS = parseInt(process.env.BACKUP_TIMEOUT_MS || '120000', 10);

// 서비스는 v2/app/services → ../../backups/db = v2/backups/db. public은 v2/app/public.
// BACKUP_DIR env로 저장 위치 오버라이드 가능(배포 커스터마이즈·격리 검증용).
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, '..', '..', 'backups', 'db');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const DUMP_RE = /^itassets_\d{8}_\d{6}\.dump$/;
const UPLOADS_RE = /^itassets_\d{8}_\d{6}\.uploads\.tar\.gz$/;

function ensureDir() { fs.mkdirSync(BACKUP_DIR, { recursive: true }); }
// BUG-13: 백업 디렉터리 접근성(생성·쓰기 가능) 상태만 반환 — 실패해도 페이지가 죽지 않게.
// compose 앱은 WORKDIR /app 기준이라 기본 경로가 /backups/db(루트)로 풀려 비루트 mkdir가 EACCES.
function dirStatus() {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    fs.accessSync(BACKUP_DIR, fs.constants.W_OK);
    return { ok: true, dir: BACKUP_DIR };
  } catch (e) {
    return { ok: false, dir: BACKUP_DIR, reason: e.code || e.message };
  }
}
function scrub(s) { return String(s || '').replace(/\s+/g, ' ').trim().slice(0, 500); }
function stamp() {
  const d = new Date(); const p = n => String(n).padStart(2, '0');
  return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

// 파일명 안전 해석: basename만 허용 + 패턴(확장자) 검증 + 실제 디렉터리 내 존재. 실패 시 null.
function resolveBackupFile(name) {
  const raw = String(name || '');
  const base = path.basename(raw);
  if (base !== raw) return null;                          // 경로 구분자 포함 → 거절(../ 등)
  if (!DUMP_RE.test(base) && !UPLOADS_RE.test(base)) return null; // 패턴/확장자 불일치
  const full = path.join(BACKUP_DIR, base);
  if (path.dirname(full) !== BACKUP_DIR) return null;     // 디렉터리 이탈 방어
  if (!fs.existsSync(full)) return null;
  return { full, base };
}

function listBackups() {
  if (!dirStatus().ok) return []; // BUG-13: 디렉터리 사용 불가 시 빈 목록(페이지는 안내 표시, 크래시 없음)
  const all = fs.readdirSync(BACKUP_DIR);
  const upSet = new Set(all.filter(f => UPLOADS_RE.test(f)).map(f => f.replace('.uploads.tar.gz', '')));
  return all.filter(f => DUMP_RE.test(f)).map(f => {
    const st = fs.statSync(path.join(BACKUP_DIR, f));
    const key = f.replace('.dump', '');
    return { name: f, size: st.size, mtime: st.mtime, hasUploads: upSet.has(key), uploadsName: upSet.has(key) ? key + '.uploads.tar.gz' : null };
  }).sort((a, b) => b.mtime - a.mtime);
}

// DB 덤프: docker exec pg_dump -Fc → 파일로 스트리밍(대용량 대비 execFile maxBuffer 회피, 셸 없음).
function runDump(outPath) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(outPath);
    const child = spawn('docker', ['exec', DB_CONTAINER, 'pg_dump', '-U', PGUSER, '-d', PGDB, '-Fc']);
    let stderr = '', killed = false, done = false, streamDone = false, exitCode = null;
    const timer = setTimeout(() => { killed = true; try { child.kill('SIGKILL'); } catch (_) {} }, TIMEOUT_MS);
    const fail = (msg) => { if (done) return; done = true; clearTimeout(timer); try { out.destroy(); } catch (_) {} try { fs.unlinkSync(outPath); } catch (_) {} reject(new Error(msg)); };
    const maybeDone = () => { if (done) return; if (exitCode === 0 && !killed && streamDone) { done = true; clearTimeout(timer); resolve(); } };
    child.stdout.pipe(out);
    out.on('error', e => fail('백업 파일 쓰기 실패: ' + e.message));
    out.on('finish', () => { streamDone = true; maybeDone(); });
    child.stderr.on('data', d => { if (stderr.length < 4000) stderr += d.toString(); });
    child.on('error', e => fail('pg_dump 실행 실패(docker exec — 컨테이너명/권한 확인): ' + e.message));
    child.on('close', code => {
      exitCode = code;
      if (killed) return fail('백업 타임아웃(' + Math.round(TIMEOUT_MS / 1000) + '초) 초과');
      if (code !== 0) return fail('pg_dump 실패(code ' + code + '): ' + scrub(stderr));
      maybeDone();
    });
  });
}

// uploads tar: 앱 로컬 FS 직접(비컨테이너 호스트 경로). 디렉터리 없으면 skip.
function runUploadsTar(outPath) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(path.join(PUBLIC_DIR, 'uploads'))) return resolve({ skipped: true });
    execFile('tar', ['czf', outPath, '-C', PUBLIC_DIR, 'uploads'], { timeout: TIMEOUT_MS }, (err, so, se) => {
      if (err) { try { fs.unlinkSync(outPath); } catch (_) {} return reject(new Error('uploads tar 실패: ' + scrub(se || err.message))); }
      resolve({ skipped: false });
    });
  });
}

// 회전: 최신 KEEP개 초과분(오래된 순) 삭제. 삭제된 dump 파일명 배열 반환(짝 uploads도 함께 삭제).
function rotate() {
  const dumps = listBackups(); // 최신순
  const removed = [];
  dumps.slice(KEEP).forEach(b => {
    try { fs.unlinkSync(path.join(BACKUP_DIR, b.name)); } catch (_) {}
    if (b.uploadsName) { try { fs.unlinkSync(path.join(BACKUP_DIR, b.uploadsName)); } catch (_) {} }
    removed.push(b.name);
  });
  return removed;
}

async function createBackup(opts) {
  const st = dirStatus();
  if (!st.ok) throw new Error('백업 디렉터리를 쓸 수 없습니다(' + st.reason + '): ' + st.dir + ' — compose 환경은 호스트에서 scripts/backup.sh 를 사용하세요(DEPLOY §5-1).');
  const ts = stamp();
  const dumpName = 'itassets_' + ts + '.dump';
  const dumpPath = path.join(BACKUP_DIR, dumpName);
  if (fs.existsSync(dumpPath)) throw new Error('동일 타임스탬프 백업이 이미 있습니다. 잠시 후 다시 시도하세요.');
  await runDump(dumpPath);
  let uploadsName = null, uploadsSkipped = false;
  if (opts && opts.withUploads) {
    const un = 'itassets_' + ts + '.uploads.tar.gz';
    const r = await runUploadsTar(path.join(BACKUP_DIR, un));
    if (r.skipped) uploadsSkipped = true; else uploadsName = un;
  }
  const size = fs.statSync(dumpPath).size;
  const removed = rotate();
  return { dumpName, uploadsName, uploadsSkipped, size, removed };
}

// 삭제: dump + 짝 uploads. 반환: 삭제된 파일명 배열(감사용). 없으면 null.
function deleteBackup(name) {
  const f = resolveBackupFile(name);
  if (!f || !DUMP_RE.test(f.base)) return null; // dump 파일만 삭제 진입점(짝은 함께)
  const deleted = [f.base];
  fs.unlinkSync(f.full);
  const upName = f.base.replace('.dump', '') + '.uploads.tar.gz';
  const upPath = path.join(BACKUP_DIR, upName);
  if (fs.existsSync(upPath)) { fs.unlinkSync(upPath); deleted.push(upName); }
  return deleted;
}

// 복원 가이드용 실값(컨테이너명·실경로).
function restoreContext(name) {
  const f = name ? resolveBackupFile(name) : null;
  return {
    container: DB_CONTAINER, user: PGUSER, db: PGDB,
    dumpPath: f ? f.full : null, dumpName: f ? f.base : null,
    uploadsName: (f && DUMP_RE.test(f.base) && fs.existsSync(path.join(BACKUP_DIR, f.base.replace('.dump', '') + '.uploads.tar.gz'))) ? f.base.replace('.dump', '') + '.uploads.tar.gz' : null,
    backupDir: BACKUP_DIR
  };
}

module.exports = {
  BACKUP_DIR, DB_CONTAINER, KEEP, DUMP_RE, UPLOADS_RE,
  ensureDir, dirStatus, listBackups, resolveBackupFile, createBackup, deleteBackup, restoreContext, rotate
};
