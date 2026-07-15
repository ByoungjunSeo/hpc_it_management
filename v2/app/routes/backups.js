// T4: 백업 관리 라우트 — 전부 관리자 한정. 생성/목록/다운로드/삭제 + 복원 가이드.
const express = require('express');
const router = express.Router();
const { requireAdmin } = require('../middleware/auth');
const AuditLog = require('../models/auditLog');
const backup = require('../services/backupManager');

router.use(requireAdmin);

// 목록 + 생성 폼 + (선택) 복원 가이드 섹션
router.get('/', async (req, res) => {
  try {
    const dir = backup.dirStatus();          // BUG-13: 디렉터리 사용 불가여도 페이지는 렌더(대시보드 전파 차단)
    const backups = backup.listBackups();
    const guide = req.query.guide ? backup.restoreContext(req.query.guide) : null;
    res.render('backups/index', {
      title: '백업 관리', currentPath: '/backups', extraCss: null, extraJs: null,
      backups, keep: backup.KEEP, dbContainer: backup.DB_CONTAINER, guide, dir
    });
  } catch (err) {
    req.flash('error', '백업 목록 로드 실패: ' + err.message);
    res.redirect('/');
  }
});

// 생성 (uploads 옵션)
router.post('/create', async (req, res) => {
  try {
    const withUploads = req.body.with_uploads === 'on' || req.body.with_uploads === 'true' || req.body.with_uploads === '1';
    const r = await backup.createBackup({ withUploads });
    await AuditLog.log(req, {
      action: 'backup_create', targetType: 'backup', targetId: null, targetLabel: r.dumpName,
      details: { file: r.dumpName, size: r.size, uploads: r.uploadsName || (r.uploadsSkipped ? '(skipped)' : null) }
    });
    // 회전으로 삭제된 파일은 backup_delete(사유=회전) 감사
    for (const gone of r.removed) {
      await AuditLog.log(req, { action: 'backup_delete', targetType: 'backup', targetId: null, targetLabel: gone, details: { file: gone, reason: 'rotation' } });
    }
    let msg = '백업을 생성했습니다: ' + r.dumpName + ' (' + Math.round(r.size / 1024) + ' KB)';
    if (r.uploadsName) msg += ' + uploads';
    else if (r.uploadsSkipped) msg += ' (uploads 없음 — 스킵)';
    if (r.removed.length) msg += ' · 회전으로 ' + r.removed.length + '개 정리';
    req.flash('success', msg);
    res.redirect('/backups');
  } catch (err) {
    req.flash('error', '백업 생성 실패: ' + err.message);
    res.redirect('/backups');
  }
});

// 다운로드 (path traversal 방어 — resolveBackupFile 화이트리스트)
router.get('/download/:name', async (req, res) => {
  const f = backup.resolveBackupFile(req.params.name);
  if (!f) { req.flash('error', '유효하지 않은 백업 파일입니다.'); return res.redirect('/backups'); }
  await AuditLog.log(req, { action: 'backup_download', targetType: 'backup', targetId: null, targetLabel: f.base, details: { file: f.base } });
  res.download(f.full, f.base, (err) => {
    if (err && !res.headersSent) { req.flash('error', '다운로드 실패: ' + err.message); res.redirect('/backups'); }
  });
});

// 삭제 (수동)
router.post('/delete', async (req, res) => {
  try {
    const deleted = backup.deleteBackup(req.body.name);
    if (!deleted) { req.flash('error', '유효하지 않은 백업 파일입니다.'); return res.redirect('/backups'); }
    for (const d of deleted) {
      await AuditLog.log(req, { action: 'backup_delete', targetType: 'backup', targetId: null, targetLabel: d, details: { file: d, reason: 'manual' } });
    }
    req.flash('success', '삭제했습니다: ' + deleted.join(', '));
    res.redirect('/backups');
  } catch (err) {
    req.flash('error', '삭제 실패: ' + err.message);
    res.redirect('/backups');
  }
});

module.exports = router;
