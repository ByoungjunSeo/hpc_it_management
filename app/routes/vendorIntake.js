const express = require('express');
const router = express.Router();
const VendorIntake = require('../models/vendorIntake');
const appConfig = require('../config/app');
const { requireMaintenance } = require('../middleware/auth');

// --- Admin routes ---

// List all intake requests
router.get('/', (req, res) => {
  const status = req.query.status || 'all';
  const requests = VendorIntake.findAll(status);
  const stats = VendorIntake.getStats();
  const statsMap = {};
  stats.forEach(s => { statsMap[s.status] = s.count; });

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
});

// Generate new intake link
router.post('/create-link', requireMaintenance, (req, res) => {
  const token = VendorIntake.createLink();
  const baseUrl = req.protocol + '://' + req.get('host');
  const link = baseUrl + '/intake/' + token;
  req.flash('success', '입고 신청 링크가 생성되었습니다: ' + link);
  res.redirect('/vendor-intake');
});

// View single request detail
router.get('/:id', (req, res) => {
  const request = VendorIntake.findById(req.params.id);
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
});

// Approve request
router.post('/:id/approve', requireMaintenance, (req, res) => {
  VendorIntake.approve(req.params.id, req.body.admin_notes);
  req.flash('success', '신청이 승인되었습니다.');
  res.redirect('/vendor-intake/' + req.params.id);
});

// Reject request
router.post('/:id/reject', requireMaintenance, (req, res) => {
  VendorIntake.reject(req.params.id, req.body.admin_notes);
  req.flash('success', '신청이 반려되었습니다.');
  res.redirect('/vendor-intake/' + req.params.id);
});

// Delete request
router.post('/:id/delete', requireMaintenance, (req, res) => {
  VendorIntake.delete(req.params.id);
  req.flash('success', '신청이 삭제되었습니다.');
  res.redirect('/vendor-intake');
});

module.exports = router;
