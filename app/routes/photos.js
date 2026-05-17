const express = require('express');
const router = express.Router();
const Photo = require('../models/photo');
const upload = require('../middleware/upload');
const { requireMaintenance } = require('../middleware/auth');

// GET /api/photos/:entityType/:entityId - list photos
router.get('/:entityType/:entityId', (req, res) => {
  try {
    const photos = Photo.findByEntity(req.params.entityType, parseInt(req.params.entityId));
    res.json({ success: true, photos });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/photos/:entityType/:entityId - upload photos
router.post('/:entityType/:entityId', requireMaintenance, (req, res) => {
  upload.array('photos', 10)(req, res, function (err) {
    if (err) {
      console.error('[Photo Upload] multer error:', err.message);
      return res.status(400).json({ success: false, error: err.message });
    }
    try {
      if (!req.files || req.files.length === 0) {
        return res.status(400).json({ success: false, error: '파일이 선택되지 않았습니다.' });
      }
      const uploadedBy = req.session.displayName || req.session.username || null;
      const ids = Photo.bulkCreate(
        req.params.entityType,
        parseInt(req.params.entityId),
        req.files,
        uploadedBy
      );
      const photos = Photo.findByEntity(req.params.entityType, parseInt(req.params.entityId));
      res.json({ success: true, ids, photos });
    } catch (error) {
      console.error('[Photo Upload] error:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });
});

// DELETE /api/photos/:id - delete a photo
router.delete('/:id', requireMaintenance, (req, res) => {
  try {
    const deleted = Photo.delete(parseInt(req.params.id));
    if (!deleted) {
      return res.status(404).json({ success: false, error: '사진을 찾을 수 없습니다.' });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
