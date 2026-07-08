const express = require('express');
const router = express.Router();
const Lending = require('../models/lending');
const Photo = require('../models/photo');
const Asset = require('../models/asset');
const ComputingModule = require('../models/computingModule');
const ModuleInventory = require('../models/moduleInventory');
const ModuleInventoryLog = require('../models/moduleInventoryLog');
const ModuleTransferLog = require('../models/moduleTransferLog');
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

// Fault return modules (B-4d-8a, v1 L122–153 이식)
router.get('/fault-return-modules/:assetId', async (req, res) => {
  try {
    const assetId = req.params.assetId;
    const asset = await Asset.findById(assetId);
    if (!asset) {
      return res.status(404).json({ error: '자산을 찾을 수 없습니다.' });
    }
    const modules = await ComputingModule.findByAsset(assetId);
    res.json({
      asset: {
        id: asset.id,
        management_number: asset.management_number,
        model_name: asset.model_name,
        vendor_name: asset.vendor_name
      },
      modules: modules.map(m => ({
        id: m.id,
        module_type: m.module_type,
        model: m.model,
        manufacturer: m.manufacturer,
        capacity: m.capacity,
        count: m.count || 1,
        owner: m.owner || 'company',
        owner_vendor_id: m.owner_vendor_id,
        owner_vendor_name: m.owner_vendor_name,
        specification: m.specification
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Fault return processing (B-4d-8a, v1 L156–314 이식)
// keep+자사의 total/spare 수동 증분은 v1에서도 recalculateInUse가 즉시 재유도(total=storage+in_use,
// spare=storage)하는 dead write — 수량 불변식 유지 확인(Part 0 검산) 후 충실이식.
// 트랜잭션 경계: v1 db.transaction → 8b 관례대로 순차 실행 이식(모델 pool 개별 연결).
router.post('/:id/fault-return', requireMaintenance, async (req, res) => {
  try {
    const lendingId = req.params.id;
    const { asset_id, reason, expected_return_date, fault_notes, modules } = req.body;

    if (!asset_id) throw new Error('대상 자산을 선택해주세요.');

    const lending = await Lending.findById(lendingId);
    if (!lending) throw new Error('대여 정보를 찾을 수 없습니다.');

    const asset = await Asset.findById(asset_id);
    if (!asset) throw new Error('자산을 찾을 수 없습니다.');

    const assetLabel = asset.management_number || asset.model_name || `ID:${asset.id}`;
    const parsedModules = typeof modules === 'string' ? JSON.parse(modules) : (modules || []);
    const today = new Date().toISOString().split('T')[0];

    const transferLogs = [];

    for (const mod of parsedModules) {
      const cm = await ComputingModule.findById(mod.id);
      if (!cm) continue;

      const action = mod.action; // 'keep' = 장비실 보관, 'send' = 업체로 반출

      if (action === 'keep') {
        if (cm.owner === 'company' || !cm.owner) {
          // 자사 모듈 → specification(item_code)으로 module_inventory 찾아 storage_quantity 증가
          const itemCode = cm.specification;
          if (itemCode) {
            const inv = await ModuleInventory.findByCode(itemCode);
            if (inv) {
              await pool.query(`
                UPDATE module_inventory
                SET storage_quantity = storage_quantity + $1,
                    total_quantity = total_quantity + $1,
                    spare_quantity = spare_quantity + $1,
                    updated_at = CURRENT_TIMESTAMP
                WHERE item_code = $2
              `, [cm.count || 1, itemCode]);

              await ModuleInventoryLog.create({
                item_code: itemCode,
                event_type: 'fault_return_keep',
                quantity_change: cm.count || 1,
                before_total: inv.total_quantity,
                after_total: inv.total_quantity + (cm.count || 1),
                before_spare: inv.spare_quantity,
                after_spare: inv.spare_quantity + (cm.count || 1),
                asset_id: asset.id,
                asset_label: assetLabel,
                from_asset_id: asset.id,
                from_asset_label: assetLabel,
                to_asset_label: '장비실(장애반납)',
                notes: `[장애반납] ${reason || '장애'} - 자사 모듈 장비실 보관`
              });
            }
          }
        } else {
          // 업체 모듈 → 임시 코드로 module_inventory에 upsert
          const vendorName = cm.owner_vendor_name || 'vendor';
          const typeLabel = cm.module_type || 'etc';
          const tmpCode = `tmp-${vendorName}-${typeLabel}-${cm.id}`;

          const existing = await ModuleInventory.findByCode(tmpCode);
          if (existing) {
            await pool.query(`
              UPDATE module_inventory
              SET storage_quantity = storage_quantity + $1,
                  total_quantity = total_quantity + $1,
                  spare_quantity = spare_quantity + $1,
                  updated_at = CURRENT_TIMESTAMP
              WHERE item_code = $2
            `, [cm.count || 1, tmpCode]);
          } else {
            await ModuleInventory.upsert({
              module_type: cm.module_type,
              item_code: tmpCode,
              label: `[업체보관] ${cm.model || ''} (${vendorName})`,
              manufacturer: cm.manufacturer,
              model: cm.model,
              capacity: cm.capacity,
              total_quantity: cm.count || 1,
              in_use_quantity: 0,
              spare_quantity: cm.count || 1,
              storage_quantity: cm.count || 1
            });
          }

          await ModuleInventoryLog.create({
            item_code: tmpCode,
            event_type: 'fault_return_vendor_keep',
            quantity_change: cm.count || 1,
            before_total: existing ? existing.total_quantity : 0,
            after_total: (existing ? existing.total_quantity : 0) + (cm.count || 1),
            before_spare: existing ? existing.spare_quantity : 0,
            after_spare: (existing ? existing.spare_quantity : 0) + (cm.count || 1),
            asset_id: asset.id,
            asset_label: assetLabel,
            from_asset_id: asset.id,
            from_asset_label: assetLabel,
            to_asset_label: '장비실(업체모듈 보관)',
            notes: `[장애반납] ${reason || '장애'} - 업체 모듈 장비실 보관`
          });
        }
      }

      // Transfer log for all modules (keep or send)
      transferLogs.push({
        transfer_date: today,
        module_type: cm.module_type,
        model: cm.model,
        capacity: cm.capacity,
        count: cm.count || 1,
        owner: cm.owner || 'company',
        owner_vendor_id: cm.owner_vendor_id,
        from_asset_id: asset.id,
        from_asset_label: assetLabel,
        to_asset_id: null,
        to_asset_label: action === 'keep' ? '장비실(장애반납)' : `업체반출(${lending.counterparty})`,
        reason: 'fault_return',
        notes: `[장애반납] ${reason || '장애'} - ${action === 'keep' ? '장비실 보관' : '업체 반출'}`
      });

      // 모듈을 자산에서 분리 (다른 자산으로 이동 가능하도록)
      await ComputingModule.delete(cm.id);
    }

    if (transferLogs.length > 0) {
      await ModuleTransferLog.bulkCreate(transferLogs);
    }

    // Update asset status to maintenance
    await pool.query("UPDATE assets SET status = 'maintenance', updated_at = CURRENT_TIMESTAMP WHERE id = $1", [asset_id]);

    // Mark lending as fault-returned
    await Lending.markFaultReturned(lendingId, { reason, expected_return_date, fault_notes });

    // Recalculate in_use quantities (maintenance assets excluded)
    await ModuleInventory.recalculateInUse();

    await AuditLog.log(req, {
      action: 'update',
      targetType: 'lending',
      targetId: lendingId,
      targetLabel: `장애반납: ${lending.counterparty} - ${assetLabel}`
    });

    req.flash('success', '장애반납 처리가 완료되었습니다.');
  } catch (err) {
    req.flash('error', '장애반납 실패: ' + err.message);
  }
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
