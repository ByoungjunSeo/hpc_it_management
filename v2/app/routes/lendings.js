const express = require('express');
const router = express.Router();
const Lending = require('../models/lending');
const Photo = require('../models/photo');
const appConfig = require('../config/app');
const { requireMaintenance } = require('../middleware/auth');
const AuditLog = require('../models/auditLog');
const { pool } = require('../config/database');

// List
router.get('/', async (req, res, next) => {
  try {
    const filters = {
      direction: req.query.direction || '',
      status: req.query.status || '',
      search: req.query.search || ''
    };
    const lendings = await Lending.findAll(filters);
    const stats = await Lending.getStats();

    const summary = { outbound_active: 0, inbound_active: 0 };
    stats.forEach(s => {
      if (s.direction === 'outbound' && s.status === 'active') summary.outbound_active = parseInt(s.count);
      if (s.direction === 'inbound' && s.status === 'active') summary.inbound_active = parseInt(s.count);
    });

    res.render('lendings/index', {
      title: '대여관리',
      currentPath: '/lendings',
      extraCss: null,
      extraJs: null,
      lendings,
      filters,
      summary,
      appConfig
    });
  } catch (err) {
    next(err);
  }
});

// New form
router.get('/new', (req, res) => {
  res.render('lendings/form', {
    title: '대여 등록',
    currentPath: '/lendings',
    extraCss: null,
    extraJs: null,
    lending: null,
    appConfig
  });
});

// Create
router.post('/', requireMaintenance, async (req, res) => {
  try {
    const items = [];
    const types = req.body.item_type || [];
    const codes = req.body.item_code || [];
    const quantities = req.body.item_quantity || [];
    const descriptions = req.body.item_description || [];

    const typesArr = Array.isArray(types) ? types : [types];
    const codesArr = Array.isArray(codes) ? codes : [codes];
    const quantitiesArr = Array.isArray(quantities) ? quantities : [quantities];
    const descriptionsArr = Array.isArray(descriptions) ? descriptions : [descriptions];

    for (let i = 0; i < typesArr.length; i++) {
      if (typesArr[i]) {
        items.push({
          item_type: typesArr[i],
          item_code: codesArr[i] || null,
          quantity: parseInt(quantitiesArr[i]) || 1,
          description: descriptionsArr[i] || null
        });
      }
    }

    await Lending.create(req.body, items);
    await AuditLog.log(req, { action: 'create', targetType: 'lending', targetLabel: req.body.counterparty + ' ' + req.body.direction });
    req.flash('success', '대여가 등록되었습니다.');
  } catch (err) {
    req.flash('error', '등록 실패: ' + err.message);
  }
  res.redirect(req.body.returnTo || '/lendings');
});

// Vendor assets for fault return modal
router.get('/vendor-assets', async (req, res) => {
  try {
    const counterparty = req.query.counterparty;
    if (!counterparty) {
      return res.json({ assets: [] });
    }
    // Find vendor by name matching counterparty
    let { rows: vendors } = await pool.query(
      'SELECT id, vendor_name FROM vendor_info WHERE vendor_name = $1', [counterparty]
    );
    if (vendors.length === 0) {
      ({ rows: vendors } = await pool.query(
        `SELECT id, vendor_name FROM vendor_info
         WHERE $1 ILIKE '%' || vendor_name || '%' OR vendor_name ILIKE '%' || $1 || '%'`,
        [counterparty]
      ));
    }
    if (vendors.length === 0) {
      return res.json({ assets: [] });
    }
    const vendor = vendors[0];
    const { rows: assets } = await pool.query(`
      SELECT a.id, a.management_number, a.model_name, a.asset_number, a.status
      FROM assets a
      LEFT JOIN assets parent ON a.parent_asset_id = parent.id
      WHERE (a.vendor_id = $1 OR (a.vendor_id IS NULL AND parent.vendor_id = $1))
        AND a.status IN ('active', 'maintenance')
      ORDER BY a.management_number
    `, [vendor.id]);
    res.json({ assets, vendor_name: vendor.vendor_name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Fault return modules — B-4d 예정 (스텁)
router.get('/fault-return-modules/:assetId', (req, res) => {
  res.status(503).json({ error: 'fault-return-modules: B-4d 예정' });
});

// Fault return processing — B-4d 예정 (스텁)
router.post('/:id/fault-return', requireMaintenance, (req, res) => {
  req.flash('error', '장애반납 기능은 B-4d에서 이식 예정입니다.');
  res.redirect(req.body.returnTo || '/lendings');
});

// Edit form
router.get('/:id/edit', async (req, res, next) => {
  try {
    const lending = await Lending.findById(req.params.id);
    if (!lending) {
      req.flash('error', '대여 정보를 찾을 수 없습니다.');
      return res.redirect('/lendings');
    }
    const lendingPhotos = await Photo.findByEntity('lending', lending.id);
    res.render('lendings/form', {
      title: '대여 수정',
      currentPath: '/lendings',
      extraCss: null,
      extraJs: null,
      lending,
      lendingPhotos,
      appConfig,
      returnTo: req.query.returnTo || req.get('Referer') || ''
    });
  } catch (err) {
    next(err);
  }
});

// Update
router.post('/:id', requireMaintenance, async (req, res) => {
  try {
    const items = [];
    const types = req.body.item_type || [];
    const codes = req.body.item_code || [];
    const quantities = req.body.item_quantity || [];
    const descriptions = req.body.item_description || [];

    const typesArr = Array.isArray(types) ? types : [types];
    const codesArr = Array.isArray(codes) ? codes : [codes];
    const quantitiesArr = Array.isArray(quantities) ? quantities : [quantities];
    const descriptionsArr = Array.isArray(descriptions) ? descriptions : [descriptions];

    for (let i = 0; i < typesArr.length; i++) {
      if (typesArr[i]) {
        items.push({
          item_type: typesArr[i],
          item_code: codesArr[i] || null,
          quantity: parseInt(quantitiesArr[i]) || 1,
          description: descriptionsArr[i] || null
        });
      }
    }

    await Lending.update(req.params.id, req.body, items);
    await AuditLog.log(req, { action: 'update', targetType: 'lending', targetId: req.params.id, targetLabel: req.body.counterparty });
    req.flash('success', '대여가 수정되었습니다.');
  } catch (err) {
    req.flash('error', '수정 실패: ' + err.message);
  }
  res.redirect(req.body.returnTo || '/lendings');
});

// Delete
router.post('/:id/delete', requireMaintenance, async (req, res) => {
  try {
    await Photo.deleteByEntity('lending', parseInt(req.params.id));
    await Lending.delete(req.params.id);
    await AuditLog.log(req, { action: 'delete', targetType: 'lending', targetId: req.params.id });
    req.flash('success', '대여가 삭제되었습니다.');
  } catch (err) {
    req.flash('error', '삭제 실패: ' + err.message);
  }
  res.redirect(req.body.returnTo || req.get('Referer') || '/lendings');
});

// Return
router.post('/:id/return', requireMaintenance, async (req, res) => {
  try {
    await Lending.markReturned(req.params.id);
    await AuditLog.log(req, { action: 'update', targetType: 'lending', targetId: req.params.id, targetLabel: '반납처리' });
    req.flash('success', '반납 처리되었습니다.');
  } catch (err) {
    req.flash('error', '반납 처리 실패: ' + err.message);
  }
  res.redirect(req.body.returnTo || req.get('Referer') || '/lendings');
});

module.exports = router;
