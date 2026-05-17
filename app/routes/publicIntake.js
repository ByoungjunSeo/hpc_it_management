const express = require('express');
const router = express.Router();
const VendorIntake = require('../models/vendorIntake');

// Public intake form (accessed by vendor via token link)
router.get('/:token', (req, res) => {
  const existing = VendorIntake.findByToken(req.params.token);

  // Token not found -> show direct form
  if (!existing) {
    return res.render('vendor-intake/public-form', {
      title: '서버 입고 신청',
      token: req.params.token,
      request: null,
      submitted: false,
      error: null,
      invalid: true
    });
  }

  // Already submitted
  if (existing.status !== 'draft') {
    return res.render('vendor-intake/public-form', {
      title: '서버 입고 신청',
      token: req.params.token,
      request: existing,
      submitted: true,
      error: null,
      invalid: false
    });
  }

  // Show blank form
  res.render('vendor-intake/public-form', {
    title: '서버 입고 신청',
    token: req.params.token,
    request: existing,
    submitted: false,
    error: null,
    invalid: false
  });
});

// Submit intake form
router.post('/:token', (req, res) => {
  const existing = VendorIntake.findByToken(req.params.token);

  if (!existing || existing.status !== 'draft') {
    return res.render('vendor-intake/public-form', {
      title: '서버 입고 신청',
      token: req.params.token,
      request: existing,
      submitted: existing && existing.status !== 'draft',
      error: '유효하지 않은 링크이거나 이미 제출된 신청입니다.',
      invalid: !existing
    });
  }

  // Validate required fields
  if (!req.body.company_name || !req.body.contact_name) {
    return res.render('vendor-intake/public-form', {
      title: '서버 입고 신청',
      token: req.params.token,
      request: { ...existing, ...req.body },
      submitted: false,
      error: '업체명과 담당자명은 필수 항목입니다.',
      invalid: false
    });
  }

  VendorIntake.submit(req.params.token, req.body);

  const updated = VendorIntake.findByToken(req.params.token);
  res.render('vendor-intake/public-form', {
    title: '서버 입고 신청',
    token: req.params.token,
    request: updated,
    submitted: true,
    error: null,
    invalid: false
  });
});

// Direct public form (no pre-generated token needed)
router.get('/', (req, res) => {
  res.render('vendor-intake/public-form', {
    title: '서버 입고 신청',
    token: null,
    request: null,
    submitted: false,
    error: null,
    invalid: false
  });
});

// Direct submit (creates its own token)
router.post('/', (req, res) => {
  if (!req.body.company_name || !req.body.contact_name) {
    return res.render('vendor-intake/public-form', {
      title: '서버 입고 신청',
      token: null,
      request: req.body,
      submitted: false,
      error: '업체명과 담당자명은 필수 항목입니다.',
      invalid: false
    });
  }

  VendorIntake.directSubmit(req.body);

  res.render('vendor-intake/public-form', {
    title: '서버 입고 신청',
    token: null,
    request: req.body,
    submitted: true,
    error: null,
    invalid: false
  });
});

module.exports = router;
