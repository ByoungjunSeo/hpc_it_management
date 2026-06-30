const express = require('express');
const router = express.Router();
const VendorIntake = require('../models/vendorIntake');
const appConfig = require('../config/app');
const { requireMaintenance } = require('../middleware/auth');
const AuditLog = require('../models/auditLog');

// List all intake requests
router.get('/', async (req, res, next) => {
  try {
    const status = req.query.status || 'all';
    const requests = await VendorIntake.findAll(status);
    const stats = await VendorIntake.getStats();
    const statsMap = {};
    stats.forEach(s => { statsMap[s.status] = parseInt(s.count); });

    res.render('vendor-intake/index', {
      title: '입고 신청 관리',
      currentPath: '/vendor-intake',
      extraCss: null,
      extraJs: null,
      requests,
      currentStatus: status,
      stats: statsMap,
      appConfig
    });
  } catch (err) {
    next(err);
  }
});

// Generate new intake link
router.post('/create-link', requireMaintenance, async (req, res) => {
  try {
    const token = await VendorIntake.createLink();
    const baseUrl = req.protocol + '://' + req.get('host');
    const link = baseUrl + '/intake/' + token;
    req.flash('success', '입고 신청 링크가 생성되었습니다: ' + link);
  } catch (err) {
    req.flash('error', '링크 생성 실패: ' + err.message);
  }
  res.redirect('/vendor-intake');
});

// View single request detail
router.get('/:id', async (req, res, next) => {
  try {
    const request = await VendorIntake.findById(req.params.id);
    if (!request) {
      req.flash('error', '신청을 찾을 수 없습니다.');
      return res.redirect('/vendor-intake');
    }
    res.render('vendor-intake/detail', {
      title: '입고 신청 상세',
      currentPath: '/vendor-intake',
      extraCss: null,
      extraJs: null,
      request,
      appConfig
    });
  } catch (err) {
    next(err);
  }
});

// Approve request
router.post('/:id/approve', requireMaintenance, async (req, res) => {
  try {
    await VendorIntake.approve(req.params.id, req.body.admin_notes);
    await AuditLog.log(req, { action: 'update', targetType: 'vendor_intake', targetId: req.params.id, targetLabel: '승인' });
    req.flash('success', '신청이 승인되었습니다.');
  } catch (err) {
    req.flash('error', '승인 실패: ' + err.message);
  }
  res.redirect('/vendor-intake/' + req.params.id);
});

// Reject request
router.post('/:id/reject', requireMaintenance, async (req, res) => {
  try {
    await VendorIntake.reject(req.params.id, req.body.admin_notes);
    await AuditLog.log(req, { action: 'update', targetType: 'vendor_intake', targetId: req.params.id, targetLabel: '반려' });
    req.flash('success', '신청이 반려되었습니다.');
  } catch (err) {
    req.flash('error', '반려 실패: ' + err.message);
  }
  res.redirect('/vendor-intake/' + req.params.id);
});

// Delete request
router.post('/:id/delete', requireMaintenance, async (req, res) => {
  try {
    await VendorIntake.delete(req.params.id);
    await AuditLog.log(req, { action: 'delete', targetType: 'vendor_intake', targetId: req.params.id });
    req.flash('success', '신청이 삭제되었습니다.');
  } catch (err) {
    req.flash('error', '삭제 실패: ' + err.message);
  }
  res.redirect('/vendor-intake');
});

module.exports = router;
