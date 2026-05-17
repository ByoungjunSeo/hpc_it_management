const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { getDb } = require('../config/database');
const { requireAdmin } = require('../middleware/auth');
const AuditLog = require('../models/auditLog');

const BACKUPS_DIR = path.join(__dirname, '..', 'data', 'backups');

// Validate filename to prevent path traversal
function isValidFilename(name) {
  return /^it_assets_backup_\d{8}_\d{6}\.db$/.test(name);
}

// Backup list
router.get('/', requireAdmin, (req, res) => {
  let backups = [];
  if (fs.existsSync(BACKUPS_DIR)) {
    backups = fs.readdirSync(BACKUPS_DIR)
      .filter(f => f.endsWith('.db'))
      .map(f => {
        const filePath = path.join(BACKUPS_DIR, f);
        const stat = fs.statSync(filePath);
        return {
          filename: f,
          size: (stat.size / 1024 / 1024).toFixed(2),
          created: stat.mtime.toISOString().substring(0, 19).replace('T', ' ')
        };
      })
      .sort((a, b) => b.created.localeCompare(a.created));
  }
  res.render('backup/index', {
    title: '백업 관리',
    currentPath: '/backup',
    extraCss: null,
    extraJs: null,
    backups
  });
});

// Create backup
router.post('/create', requireAdmin, async (req, res) => {
  try {
    const db = getDb();
    const now = new Date();
    const filename = 'it_assets_backup_' +
      now.getFullYear() +
      String(now.getMonth() + 1).padStart(2, '0') +
      String(now.getDate()).padStart(2, '0') + '_' +
      String(now.getHours()).padStart(2, '0') +
      String(now.getMinutes()).padStart(2, '0') +
      String(now.getSeconds()).padStart(2, '0') + '.db';
    const destPath = path.join(BACKUPS_DIR, filename);

    if (!fs.existsSync(BACKUPS_DIR)) {
      fs.mkdirSync(BACKUPS_DIR, { recursive: true });
    }

    await db.backup(destPath);
    AuditLog.log(req, { action: 'backup', targetType: 'system', targetLabel: filename, details: '수동 백업 생성' });
    req.flash('success', '백업이 생성되었습니다: ' + filename);
  } catch (err) {
    req.flash('error', '백업 생성 실패: ' + err.message);
  }
  res.redirect('/backup');
});

// Download backup
router.get('/download/:file', requireAdmin, (req, res) => {
  const filename = req.params.file;
  if (!isValidFilename(filename)) {
    req.flash('error', '잘못된 파일명입니다.');
    return res.redirect('/backup');
  }
  const filePath = path.join(BACKUPS_DIR, filename);
  if (!fs.existsSync(filePath)) {
    req.flash('error', '파일을 찾을 수 없습니다.');
    return res.redirect('/backup');
  }
  res.download(filePath, filename);
});

// Delete backup
router.post('/delete/:file', requireAdmin, (req, res) => {
  const filename = req.params.file;
  if (!isValidFilename(filename)) {
    req.flash('error', '잘못된 파일명입니다.');
    return res.redirect('/backup');
  }
  const filePath = path.join(BACKUPS_DIR, filename);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    AuditLog.log(req, { action: 'delete', targetType: 'backup', targetLabel: filename });
    req.flash('success', '백업이 삭제되었습니다.');
  } else {
    req.flash('error', '파일을 찾을 수 없습니다.');
  }
  res.redirect('/backup');
});

module.exports = router;
