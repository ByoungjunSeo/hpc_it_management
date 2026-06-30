const express = require('express');
const router = express.Router();
const Photo = require('../models/photo');
const upload = require('../middleware/upload');
const { requireMaintenance } = require('../middleware/auth');
const AuditLog = require('../models/auditLog');

// GET /api/photos/:entityType/:entityId - list photos
router.get('/:entityType/:entityId', async (req, res) => {
  try {
    const photos = await Photo.findByEntity(req.params.entityType, parseInt(req.params.entityId));
    res.json({ success: true, photos });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/photos/:entityType/:entityId - upload photos
router.post('/:entityType/:entityId', requireMaintenance, (req, res) => {
  upload.array('photos', 10)(req, res, async function (err) {
    if (err) {
      console.error('[Photo Upload] multer error:', err.message);
      return res.status(400).json({ success: false, error: err.message });
    }
    try {
      if (!req.files || req.files.length === 0) {
        return res.status(400).json({ success: false, error: '파일이 선택되지 않았습니다.' });
      }
      const uploadedBy = req.session.displayName || req.session.username || null;
      const ids = await Photo.bulkCreate(
        req.params.entityType,
        parseInt(req.params.entityId),
        req.files,
        uploadedBy
      );
      const photos = await Photo.findByEntity(req.params.entityType, parseInt(req.params.entityId));

      await AuditLog.log(req, {
        action: 'create', targetType: 'photo',
        targetLabel: req.params.entityType + '/' + req.params.entityId + ' (' + ids.length + '장)'
      });

      res.json({ success: true, ids, photos });
    } catch (error) {
      console.error('[Photo Upload] error:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });
});

// DELETE /api/photos/:id - delete a photo
router.delete('/:id', requireMaintenance, async (req, res) => {
  try {
    const deleted = await Photo.delete(parseInt(req.params.id));
    if (!deleted) {
      return res.status(404).json({ success: false, error: '사진을 찾을 수 없습니다.' });
    }

    await AuditLog.log(req, {
      action: 'delete', targetType: 'photo',
      targetLabel: 'photo #' + req.params.id
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
