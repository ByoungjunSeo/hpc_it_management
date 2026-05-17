const multer = require('multer');
const path = require('path');
const crypto = require('crypto');

const UPLOAD_BASE = path.join(__dirname, '..', 'public', 'uploads', 'photos');

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const entityType = req.params.entityType || 'assets';
    const subDirMap = { module: 'modules', lending: 'lendings' };
    const subDir = subDirMap[entityType] || 'assets';
    cb(null, path.join(UPLOAD_BASE, subDir));
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    const uniqueName = Date.now() + '-' + crypto.randomBytes(6).toString('hex') + ext;
    cb(null, uniqueName);
  }
});

function fileFilter(req, file, cb) {
  const allowed = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
  const ext = path.extname(file.originalname).toLowerCase();
  if (allowed.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error('이미지 파일만 업로드 가능합니다 (jpg, png, gif, webp)'), false);
  }
}

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB per file
    files: 10 // max 10 files per request
  }
});

module.exports = upload;
