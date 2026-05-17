const express = require('express');
const router = express.Router();
const Lending = require('../models/lending');
const appConfig = require('../config/app');
const { requireMaintenance } = require('../middleware/auth');
const AuditLog = require('../models/auditLog');
const { getDb } = require('../config/database');
const ComputingModule = require('../models/computingModule');
const ModuleInventory = require('../models/moduleInventory');
const ModuleTransferLog = require('../models/moduleTransferLog');
const ModuleInventoryLog = require('../models/moduleInventoryLog');
const Asset = require('../models/asset');
const Photo = require('../models/photo');

// List
router.get('/', (req, res) => {
  const filters = {
    direction: req.query.direction || '',
    status: req.query.status || '',
    search: req.query.search || ''
  };
  const lendings = Lending.findAll(filters);
  const stats = Lending.getStats();

  // Compute summary counts
  const summary = { outbound_active: 0, inbound_active: 0 };
  stats.forEach(s => {
    if (s.direction === 'outbound' && s.status === 'active') summary.outbound_active = s.count;
    if (s.direction === 'inbound' && s.status === 'active') summary.inbound_active = s.count;
  });

  res.render('lendings/index', {
    title: '\ub300\uc5ec\uad00\ub9ac',
    currentPath: '/lendings',
    extraCss: null,
    extraJs: null,
    lendings,
    filters,
    summary,
    appConfig
  });
});

// New form
router.get('/new', (req, res) => {
  res.render('lendings/form', {
    title: '\ub300\uc5ec \ub4f1\ub85d',
    currentPath: '/lendings',
    extraCss: null,
    extraJs: null,
    lending: null,
    appConfig
  });
});

// Create
router.post('/', requireMaintenance, (req, res) => {
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

    Lending.create(req.body, items);
    AuditLog.log(req, { action: 'create', targetType: 'lending', targetLabel: req.body.counterparty + ' ' + req.body.direction });
    req.flash('success', '\ub300\uc5ec\uac00 \ub4f1\ub85d\ub418\uc5c8\uc2b5\ub2c8\ub2e4.');
  } catch (err) {
    req.flash('error', '\ub4f1\ub85d \uc2e4\ud328: ' + err.message);
  }
  res.redirect(req.body.returnTo || '/lendings');
});

// Vendor assets for fault return modal
router.get('/vendor-assets', (req, res) => {
  try {
    const counterparty = req.query.counterparty;
    if (!counterparty) {
      return res.json({ assets: [] });
    }
    const db = getDb();
    // Find vendor by name matching counterparty (exact → LIKE fallback)
    let vendor = db.prepare('SELECT id, vendor_name FROM vendor_info WHERE vendor_name = ?').get(counterparty);
    if (!vendor) {
      vendor = db.prepare('SELECT id, vendor_name FROM vendor_info WHERE ? LIKE \'%\' || vendor_name || \'%\' OR vendor_name LIKE \'%\' || ? || \'%\'').get(counterparty, counterparty);
    }
    if (!vendor) {
      return res.json({ assets: [] });
    }
    // vendor_id 직접 매칭 + 부모 자산의 vendor_id 폴백 (다중노드 자식 포함)
    const assets = db.prepare(`
      SELECT a.id, a.management_number, a.model_name, a.asset_number, a.status
      FROM assets a
      LEFT JOIN assets parent ON a.parent_asset_id = parent.id
      WHERE (a.vendor_id = ? OR (a.vendor_id IS NULL AND parent.vendor_id = ?))
        AND a.status IN ('active', 'maintenance')
      ORDER BY a.management_number
    `).all(vendor.id, vendor.id);
    res.json({ assets, vendor_name: vendor.vendor_name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Fault return modules for a specific asset
router.get('/fault-return-modules/:assetId', (req, res) => {
  try {
    const assetId = req.params.assetId;
    const asset = Asset.findById(assetId);
    if (!asset) {
      return res.status(404).json({ error: '자산을 찾을 수 없습니다.' });
    }
    const modules = ComputingModule.findByAsset(assetId);
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

// Fault return processing
router.post('/:id/fault-return', requireMaintenance, (req, res) => {
  try {
    const lendingId = req.params.id;
    const { asset_id, reason, expected_return_date, fault_notes, modules } = req.body;

    if (!asset_id) throw new Error('대상 자산을 선택해주세요.');

    const lending = Lending.findById(lendingId);
    if (!lending) throw new Error('대여 정보를 찾을 수 없습니다.');

    const asset = Asset.findById(asset_id);
    if (!asset) throw new Error('자산을 찾을 수 없습니다.');

    const assetLabel = asset.management_number || asset.model_name || `ID:${asset.id}`;
    const parsedModules = typeof modules === 'string' ? JSON.parse(modules) : (modules || []);
    const db = getDb();
    const today = new Date().toISOString().split('T')[0];

    const tx = db.transaction(() => {
      const transferLogs = [];

      for (const mod of parsedModules) {
        const cm = ComputingModule.findById(mod.id);
        if (!cm) continue;

        const action = mod.action; // 'keep' = 장비실 보관, 'send' = 업체로 반출

        if (action === 'keep') {
          if (cm.owner === 'company' || !cm.owner) {
            // 자사 모듈 → specification(item_code)으로 module_inventory 찾아 storage_quantity 증가
            const itemCode = cm.specification;
            if (itemCode) {
              const inv = ModuleInventory.findByCode(itemCode);
              if (inv) {
                db.prepare(`
                  UPDATE module_inventory
                  SET storage_quantity = storage_quantity + ?,
                      total_quantity = total_quantity + ?,
                      spare_quantity = spare_quantity + ?,
                      updated_at = CURRENT_TIMESTAMP
                  WHERE item_code = ?
                `).run(cm.count || 1, cm.count || 1, cm.count || 1, itemCode);

                ModuleInventoryLog.create({
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

            const existing = ModuleInventory.findByCode(tmpCode);
            if (existing) {
              db.prepare(`
                UPDATE module_inventory
                SET storage_quantity = storage_quantity + ?,
                    total_quantity = total_quantity + ?,
                    spare_quantity = spare_quantity + ?,
                    updated_at = CURRENT_TIMESTAMP
                WHERE item_code = ?
              `).run(cm.count || 1, cm.count || 1, cm.count || 1, tmpCode);
            } else {
              ModuleInventory.upsert({
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

            ModuleInventoryLog.create({
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
        ComputingModule.delete(cm.id);
      }

      if (transferLogs.length > 0) {
        ModuleTransferLog.bulkCreate(transferLogs);
      }

      // Update asset status to maintenance
      db.prepare("UPDATE assets SET status = 'maintenance', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(asset_id);

      // Mark lending as fault-returned
      Lending.markFaultReturned(lendingId, { reason, expected_return_date, fault_notes });

      // Recalculate in_use quantities (maintenance assets excluded)
      ModuleInventory.recalculateInUse();
    });

    tx();

    AuditLog.log(req, {
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
router.get('/:id/edit', (req, res) => {
  const lending = Lending.findById(req.params.id);
  if (!lending) {
    req.flash('error', '\ub300\uc5ec \uc815\ubcf4\ub97c \ucc3e\uc744 \uc218 \uc5c6\uc2b5\ub2c8\ub2e4.');
    return res.redirect('/lendings');
  }
  const lendingPhotos = Photo.findByEntity('lending', lending.id);
  res.render('lendings/form', {
    title: '\ub300\uc5ec \uc218\uc815',
    currentPath: '/lendings',
    extraCss: null,
    extraJs: null,
    lending,
    lendingPhotos,
    appConfig,
    returnTo: req.query.returnTo || req.get('Referer') || ''
  });
});

// Update
router.post('/:id', requireMaintenance, (req, res) => {
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

    Lending.update(req.params.id, req.body, items);
    AuditLog.log(req, { action: 'update', targetType: 'lending', targetId: req.params.id, targetLabel: req.body.counterparty });
    req.flash('success', '\ub300\uc5ec\uac00 \uc218\uc815\ub418\uc5c8\uc2b5\ub2c8\ub2e4.');
  } catch (err) {
    req.flash('error', '\uc218\uc815 \uc2e4\ud328: ' + err.message);
  }
  res.redirect(req.body.returnTo || '/lendings');
});

// Delete
router.post('/:id/delete', requireMaintenance, (req, res) => {
  try {
    Photo.deleteByEntity('lending', parseInt(req.params.id));
    Lending.delete(req.params.id);
    AuditLog.log(req, { action: 'delete', targetType: 'lending', targetId: req.params.id });
    req.flash('success', '\ub300\uc5ec\uac00 \uc0ad\uc81c\ub418\uc5c8\uc2b5\ub2c8\ub2e4.');
  } catch (err) {
    req.flash('error', '\uc0ad\uc81c \uc2e4\ud328: ' + err.message);
  }
  res.redirect(req.body.returnTo || req.get('Referer') || '/lendings');
});

// Return
router.post('/:id/return', requireMaintenance, (req, res) => {
  try {
    Lending.markReturned(req.params.id);
    AuditLog.log(req, { action: 'update', targetType: 'lending', targetId: req.params.id, targetLabel: '반납처리' });
    req.flash('success', '\ubc18\ub0a9 \ucc98\ub9ac\ub418\uc5c8\uc2b5\ub2c8\ub2e4.');
  } catch (err) {
    req.flash('error', '\ubc18\ub0a9 \ucc98\ub9ac \uc2e4\ud328: ' + err.message);
  }
  res.redirect(req.body.returnTo || req.get('Referer') || '/lendings');
});

module.exports = router;
