const express = require('express');
const router = express.Router();
const { requireMaintenance } = require('../middleware/auth');
const InventoryAudit = require('../models/inventoryAudit');
const AuditLog = require('../models/auditLog');
const appConfig = require('../config/app');

// 점검 목록
router.get('/', async (req, res, next) => {
  try {
    const audits = await InventoryAudit.findAll();
    res.render('inventory-audit/index', {
      title: '재고 점검', currentPath: '/inventory-audit',
      audits, moduleTypes: appConfig.moduleTypes
    });
  } catch (err) { next(err); }
});

// 점검 세션 생성(범위 필터) → 실행 화면으로
router.post('/', requireMaintenance, async (req, res) => {
  try {
    const scope_owner = (req.body.scope_owner === 'company' || req.body.scope_owner === 'vendor') ? req.body.scope_owner : null;
    const scope_module_type = req.body.scope_module_type || null;
    const id = await InventoryAudit.create(req.session.userId, { scope_owner, scope_module_type });
    await AuditLog.log(req, { action: 'create', targetType: 'inventory_audit', targetId: id, targetLabel: '재고 점검 #' + id });
    res.redirect('/inventory-audit/' + id);
  } catch (err) {
    req.flash('error', '점검 생성 실패: ' + err.message);
    res.redirect('/inventory-audit');
  }
});

// 점검 상세/실행 (status에 따라 뷰가 분기)
router.get('/:id', async (req, res, next) => {
  try {
    const audit = await InventoryAudit.findById(req.params.id);
    if (!audit) { req.flash('error', '점검을 찾을 수 없습니다.'); return res.redirect('/inventory-audit'); }
    const items = await InventoryAudit.getItems(audit.id);
    const corrections = audit.status !== 'in_progress' ? await InventoryAudit.getCorrections(audit.id) : [];
    res.render('inventory-audit/detail', {
      title: '재고 점검 #' + audit.id, currentPath: '/inventory-audit',
      audit, items, corrections, moduleTypes: appConfig.moduleTypes
    });
  } catch (err) { next(err); }
});

// 인쇄용 점검표 (종이 실사 → 데스크톱 일괄 입력 흐름)
router.get('/:id/print', async (req, res, next) => {
  try {
    const audit = await InventoryAudit.findById(req.params.id);
    if (!audit) return res.redirect('/inventory-audit');
    const items = await InventoryAudit.getItems(audit.id);
    res.render('inventory-audit/print', { title: '점검표 #' + audit.id, layout: false, audit, items });
  } catch (err) { next(err); }
});

// 실물 수량 임시 저장 (행 단위 AJAX)
router.post('/:id/save', requireMaintenance, async (req, res) => {
  try {
    await InventoryAudit.saveItem(req.params.id, req.body.item_code, {
      actual: req.body.actual, reason: req.body.reason, ok_flag: req.body.ok_flag === 'true' || req.body.ok_flag === 'on'
    });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// 점검 완료
router.post('/:id/complete', requireMaintenance, async (req, res) => {
  try {
    await InventoryAudit.complete(req.params.id);
    await AuditLog.log(req, { action: 'complete', targetType: 'inventory_audit', targetId: parseInt(req.params.id, 10), targetLabel: '재고 점검 #' + req.params.id });
    req.flash('success', '점검을 완료했습니다. 차이 항목을 확인하고 보정을 적용하세요.');
    res.redirect('/inventory-audit/' + req.params.id);
  } catch (err) {
    req.flash('error', '완료 처리 실패: ' + err.message);
    res.redirect('/inventory-audit/' + req.params.id);
  }
});

// 보정 적용 (차이 요약 확인 후) — 옵션 B 공식으로 module_inventory 반영
router.post('/:id/apply', requireMaintenance, async (req, res) => {
  try {
    const summary = await InventoryAudit.diffSummary(req.params.id);
    const applied = await InventoryAudit.applyCorrections(req.params.id, req.session.userId);
    await AuditLog.log(req, {
      action: 'inventory_correction', targetType: 'inventory_audit', targetId: parseInt(req.params.id, 10),
      targetLabel: '재고 점검 #' + req.params.id,
      details: { applied_count: applied, items: summary.map(s => ({ item_code: s.item_code, before: s.system_storage_qty, after: s.actual_storage_qty, diff: s.diff })) }
    });
    req.flash('success', applied + '건 보정을 적용했습니다.');
    res.redirect('/inventory-audit/' + req.params.id);
  } catch (err) {
    req.flash('error', '보정 적용 실패: ' + err.message);
    res.redirect('/inventory-audit/' + req.params.id);
  }
});

// 점검 취소
router.post('/:id/cancel', requireMaintenance, async (req, res) => {
  try {
    await InventoryAudit.cancel(req.params.id);
    res.redirect('/inventory-audit');
  } catch (err) {
    req.flash('error', '취소 실패: ' + err.message);
    res.redirect('/inventory-audit/' + req.params.id);
  }
});

module.exports = router;
