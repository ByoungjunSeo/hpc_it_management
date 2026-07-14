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

function actorOf(req) {
  return {
    userId: req.session ? req.session.userId || null : null,
    username: req.session ? (req.session.displayName || req.session.username || null) : null
  };
}

// BL-13: 폼 병렬 배열 파싱 — item_id(기존 품목 보존 갱신), asset_id(장비 연결),
// release_rack(랙 해제 요청, hidden '0'/'1'로 정렬 유지)
function parseItems(body) {
  const toArr = v => (v === undefined ? [] : (Array.isArray(v) ? v : [v]));
  const ids = toArr(body.item_id);
  const types = toArr(body.item_type);
  const codes = toArr(body.item_code);
  const quantities = toArr(body.item_quantity);
  const descriptions = toArr(body.item_description);
  const assetIds = toArr(body.item_asset_id);
  const releaseRacks = toArr(body.item_release_rack);

  const items = [];
  for (let i = 0; i < types.length; i++) {
    if (!types[i]) continue;
    items.push({
      item_id: ids[i] || null,
      item_type: types[i],
      item_code: (codes[i] || '').trim() || null,
      quantity: parseInt(quantities[i]) || 1,
      description: descriptions[i] || null,
      asset_id: parseInt(assetIds[i]) || null,
      release_rack: releaseRacks[i] === '1'
    });
  }
  return items;
}

// 폼의 부품 코드 datalist용 재고 코드 목록
async function loadInventoryCodes() {
  const { rows } = await pool.query(`
    SELECT item_code, module_type, label, storage_quantity
    FROM module_inventory WHERE item_code IS NOT NULL ORDER BY item_code
  `);
  return rows;
}

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

    const summary = { outbound_active: 0, inbound_active: 0, overdue: stats.overdue };
    stats.byDirection.forEach(s => {
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
router.get('/new', async (req, res, next) => {
  try {
    res.render('lendings/form', {
      title: '대여 등록',
      currentPath: '/lendings',
      extraCss: null,
      extraJs: null,
      lending: null,
      inventoryCodes: await loadInventoryCodes(),
      appConfig
    });
  } catch (err) {
    next(err);
  }
});

// BL-13: 장비 품목의 자산 검색 위젯
router.get('/asset-search', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.json({ assets: [] });
    const s = '%' + q + '%';
    const { rows } = await pool.query(`
      SELECT id, management_number, asset_number, model_name, asset_type, status, rack_id
      FROM assets
      WHERE status <> 'decommissioned'
        AND (management_number ILIKE $1 OR asset_number ILIKE $1 OR model_name ILIKE $1)
      ORDER BY management_number NULLS LAST LIMIT 20
    `, [s]);
    res.json({ assets: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create
router.post('/', requireMaintenance, async (req, res) => {
  try {
    const items = parseItems(req.body);
    const { id, releasedAssets } = await Lending.create(req.body, items, actorOf(req));
    await AuditLog.log(req, { action: 'create', targetType: 'lending', targetId: id, targetLabel: req.body.counterparty + ' ' + req.body.direction });
    for (const a of releasedAssets) {
      await AuditLog.log(req, {
        action: 'update', targetType: 'asset', targetId: a.id,
        targetLabel: `랙 해제(대여장부 #${id}): ${a.label}`
      });
    }
    let msg = '대여가 등록되었습니다.';
    if (releasedAssets.length > 0) {
      msg += ` 랙 해제 ${releasedAssets.length}건: ` + releasedAssets.map(a => a.label).join(', ');
    }
    req.flash('success', msg);
  } catch (err) {
    req.flash('error', '등록 실패: ' + err.message);
  }
  res.redirect(req.body.returnTo || '/lendings');
});

// BL-13: 부분 반납 모달용 품목 조회
router.get('/:id/items.json', async (req, res) => {
  try {
    const lending = await Lending.findById(req.params.id);
    if (!lending) return res.status(404).json({ error: '대여 정보를 찾을 수 없습니다.' });
    res.json({
      id: lending.id,
      counterparty: lending.counterparty,
      status: lending.status,
      items: lending.items.map(it => ({
        id: it.id,
        item_type: it.item_type,
        item_code: it.item_code,
        description: it.description,
        quantity: it.quantity || 1,
        returned_quantity: it.returned_quantity || 0,
        outstanding: (it.quantity || 1) - (it.returned_quantity || 0),
        asset_label: it.asset_management_number || it.asset_model_name || null,
        inventory_linked: it.inventory_linked
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// BL-13: 품목 부분 반납 (수량 지정) — 전 품목 완납 시 상태 자동 'returned'
router.post('/:id/items/:itemId/return', requireMaintenance, async (req, res) => {
  try {
    const { completed, item } = await Lending.returnItem(
      req.params.id, req.params.itemId, req.body.quantity, actorOf(req));
    await AuditLog.log(req, {
      action: 'update', targetType: 'lending', targetId: req.params.id,
      targetLabel: `품목반납: ${item.item_type}:${item.item_code || '-'} x${req.body.quantity}`
    });
    let msg = '품목이 반납 처리되었습니다.';
    if (item.asset_id) msg += ' (자산은 자동 재실장되지 않습니다 — 필요 시 랙에 수동 배치하세요.)';
    if (completed) msg += ' 전 품목 반납 완료 — 대여 건이 반납완료로 전환되었습니다.';
    req.flash('success', msg);
  } catch (err) {
    req.flash('error', '품목 반납 실패: ' + err.message);
  }
  res.redirect(req.body.returnTo || req.get('Referer') || '/lendings');
});

// Vendor assets for fault return modal
// BL-13: counterparty_vendor_id FK 우선 매칭(ILIKE 취약점 해소), 이름 매칭은 폴백
router.get('/vendor-assets', async (req, res) => {
  try {
    let vendor = null;
    if (req.query.lending_id) {
      const { rows } = await pool.query(`
        SELECT v.id, v.vendor_name FROM lendings l
        JOIN vendor_info v ON v.id = l.counterparty_vendor_id
        WHERE l.id = $1
      `, [req.query.lending_id]);
      vendor = rows[0] || null;
    }
    const counterparty = req.query.counterparty;
    if (!vendor && counterparty) {
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
      vendor = vendors[0] || null;
    }
    if (!vendor) {
      return res.json({ assets: [] });
    }
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
                  spare_quantity = spare_quantity + $1,
                  total_quantity = total_quantity + $1,
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
    await Lending.markFaultReturned(lendingId, { reason, expected_return_date, fault_notes }, actorOf(req));

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
      inventoryCodes: await loadInventoryCodes(),
      appConfig,
      returnTo: req.query.returnTo || req.get('Referer') || ''
    });
  } catch (err) {
    next(err);
  }
});

// Update — 방향·상태는 모델에서 불변 처리(기존 값 유지)
router.post('/:id', requireMaintenance, async (req, res) => {
  try {
    const items = parseItems(req.body);
    const { releasedAssets } = await Lending.update(req.params.id, req.body, items, actorOf(req));
    await AuditLog.log(req, { action: 'update', targetType: 'lending', targetId: req.params.id, targetLabel: req.body.counterparty });
    for (const a of releasedAssets) {
      await AuditLog.log(req, {
        action: 'update', targetType: 'asset', targetId: a.id,
        targetLabel: `랙 해제(대여장부 #${req.params.id}): ${a.label}`
      });
    }
    let msg = '대여가 수정되었습니다.';
    if (releasedAssets.length > 0) {
      msg += ` 랙 해제 ${releasedAssets.length}건: ` + releasedAssets.map(a => a.label).join(', ');
    }
    req.flash('success', msg);
  } catch (err) {
    req.flash('error', '수정 실패: ' + err.message);
  }
  res.redirect(req.body.returnTo || '/lendings');
});

// Delete — 미반납 잔여 차감분은 모델에서 재고 복귀 후 삭제
router.post('/:id/delete', requireMaintenance, async (req, res) => {
  try {
    await Photo.deleteByEntity('lending', parseInt(req.params.id));
    await Lending.delete(req.params.id, actorOf(req));
    await AuditLog.log(req, { action: 'delete', targetType: 'lending', targetId: req.params.id });
    req.flash('success', '대여가 삭제되었습니다.');
  } catch (err) {
    req.flash('error', '삭제 실패: ' + err.message);
  }
  res.redirect(req.body.returnTo || req.get('Referer') || '/lendings');
});

// Return — 전 품목 일괄 반납 (부분 반납은 /:id/items/:itemId/return)
router.post('/:id/return', requireMaintenance, async (req, res) => {
  try {
    await Lending.returnAll(req.params.id, actorOf(req));
    await AuditLog.log(req, { action: 'update', targetType: 'lending', targetId: req.params.id, targetLabel: '전 품목 일괄 반납' });
    req.flash('success', '전 품목이 반납 처리되었습니다. (대여 중 랙에서 해제했던 자산은 자동 재실장되지 않습니다.)');
  } catch (err) {
    req.flash('error', '반납 처리 실패: ' + err.message);
  }
  res.redirect(req.body.returnTo || req.get('Referer') || '/lendings');
});

module.exports = router;
