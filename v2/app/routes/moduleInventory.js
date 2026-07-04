const express = require('express');
const router = express.Router();
const ModuleInventory = require('../models/moduleInventory');
const ModuleInventoryLog = require('../models/moduleInventoryLog');
const ModuleTransferLog = require('../models/moduleTransferLog');
const ComputingModule = require('../models/computingModule');
const Asset = require('../models/asset');
const Vendor = require('../models/vendor');
const appConfig = require('../config/app');
const { requireMaintenance } = require('../middleware/auth');
const AuditLog = require('../models/auditLog');
const { pool } = require('../config/database');

// §5: EUL 하드웨어 동기 제거. 재고 재계산만 유지.
// v1: 50+컬럼 개별 동기 (EquipmentUsageLog.updateHardwareColumns / create)
// v2: EUL은 JSONB 스냅샷 이벤트소싱 — 컬럼 동기 개념 없음. recalculateInUse만 호출.
async function syncModulesToUsageLog(assetId) {
  await ModuleInventory.recalculateInUse();
}

// EP#1: Integrated main page (tabs: inventory + installed + history)
router.get('/', async (req, res) => {
  try {
    const tab = req.query.tab || 'inventory';
    const selectedType = req.query.type || '';
    const selectedOwner = req.query.inv_owner || '';
    const selectedVendorId = req.query.inv_vendor_id || '';
    const statsByType = await ModuleInventory.getStatsByType();
    let items = await ModuleInventory.findAll(selectedType || undefined, selectedOwner || undefined);

    // Apply vendor filter
    if (selectedVendorId) {
      items = items.filter(item => String(item.owner_vendor_id) === selectedVendorId);
    }

    // Apply spare_only filter
    const spareOnly = req.query.spare_only === '1';
    if (spareOnly) {
      items = items.filter(item => item.spare_quantity > 0);
    }

    // Installed modules data
    const filters = {
      module_type: req.query.module_type,
      asset_id: req.query.asset_id,
      owner: req.query.owner,
      search: req.query.search
    };
    const modules = await ComputingModule.findAll(filters);

    // History tab data
    const historyFilters = {
      event_type: req.query.event_type,
      item_code: req.query.item_code,
      date_from: req.query.date_from,
      date_to: req.query.date_to,
      search: req.query.hist_search
    };
    const historyLogs = tab === 'history' ? await ModuleInventoryLog.findAll(historyFilters) : [];

    // All item codes for history filter dropdown
    const allItemCodes = tab === 'history' ? (await ModuleInventory.findAll()).map(i => i.item_code).filter(Boolean) : [];

    const vendors = await Vendor.findAll();

    res.render('module-inventory/index', {
      title: '부품 현황',
      currentPath: '/module-inventory',
      extraCss: null,
      extraJs: null,
      tab,
      statsByType,
      items,
      selectedType,
      selectedOwner,
      selectedVendorId,
      spareOnly,
      modules,
      filters,
      historyLogs,
      historyFilters,
      allItemCodes,
      vendors,
      appConfig
    });
  } catch (err) {
    req.flash('error', '페이지 로드 실패: ' + err.message);
    res.redirect('/');
  }
});

// EP#2: API: get usage details for a component code
// [B-4d-6 유보] getUsageByCode — EUL status='사용중' 직접조회 필요 (v2 이벤트소싱 매핑 예정)
router.get('/api/usage/:code', async (req, res) => {
  try {
    const code = req.params.code;
    const spec = await ModuleInventory.findByCode(code);
    // getUsageByCode는 EUL 의존으로 유보됨 — 빈 배열 반환
    res.json({ spec, usage: [], _notice: 'EUL 사용현황은 B-4d-6에서 이벤트소싱 매핑 예정' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// EP#3: API: get history logs for a component code
router.get('/api/history/:code', async (req, res) => {
  try {
    const code = req.params.code;
    const limit = parseInt(req.query.limit) || 100;
    const logs = await ModuleInventoryLog.findByItemCode(code, limit);
    res.json({ logs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// EP#4: Inline update module_inventory field (AJAX) + sync to computing_modules
router.post('/api/inventory/:id/inline-update', requireMaintenance, async (req, res) => {
  try {
    const item = await ModuleInventory.findById(req.params.id);
    if (!item) return res.status(404).json({ error: '부품을 찾을 수 없습니다.' });

    const { field, value } = req.body;
    const oldValue = item[field];

    await ModuleInventory.updateField(req.params.id, field, value);

    // Sync to computing_modules: match by module_type + old field value
    let syncCount = 0;
    const syncFields = ['model', 'manufacturer', 'capacity'];
    if (syncFields.includes(field) && oldValue) {
      const result = await pool.query(
        `UPDATE computing_modules SET ${field} = $1, updated_at = CURRENT_TIMESTAMP
         WHERE module_type = $2 AND ${field} = $3`,
        [value || null, item.module_type, oldValue]
      );
      syncCount = result.rowCount;
    }

    await AuditLog.log(req, {
      action: 'update',
      targetType: 'module_inventory',
      targetId: req.params.id,
      targetLabel: item.item_code,
      details: { field, oldValue, newValue: value, syncCount }
    });

    res.json({ success: true, field, value, syncCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// EP#5: API: adjust inventory quantity (incoming/outgoing)
router.post('/api/inventory/:id/adjust', requireMaintenance, async (req, res) => {
  try {
    const item = await ModuleInventory.findById(req.params.id);
    if (!item) return res.status(404).json({ error: '부품을 찾을 수 없습니다.' });

    const { quantity_change, event_type, asset_number, notes } = req.body;
    const qty = parseInt(quantity_change);
    if (!qty || qty === 0) return res.status(400).json({ error: '수량을 입력해주세요.' });

    const result = await ModuleInventory.adjustQuantity(req.params.id, qty);

    // Log the event
    await ModuleInventoryLog.create({
      item_code: item.item_code,
      event_type: event_type || (qty > 0 ? 'incoming' : 'outgoing'),
      quantity_change: qty,
      before_total: result.before_total,
      after_total: result.after_total,
      before_spare: result.before_spare,
      after_spare: result.after_spare,
      asset_number: asset_number || null,
      user_id: req.session ? req.session.userId : null,
      username: req.session ? (req.session.displayName || req.session.username) : null,
      notes: notes || null
    });

    await AuditLog.log(req, {
      action: 'update',
      targetType: 'module_inventory',
      targetId: req.params.id,
      targetLabel: item.item_code,
      details: { event_type: event_type || (qty > 0 ? 'incoming' : 'outgoing'), quantity_change: qty, ...result }
    });

    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// EP#6: API: update storage_quantity directly (from 장비실/시설 view)
// BUG-1: notes 하드코딩 (사용자 비고 무시) — v1 충실이식, B-4d-5b에서 수정 예정
router.post('/api/inventory/:id/update-storage', requireMaintenance, async (req, res) => {
  try {
    const item = await ModuleInventory.findById(req.params.id);
    if (!item) return res.status(404).json({ error: '부품을 찾을 수 없습니다.' });

    const newStorage = parseInt(req.body.storage_quantity);
    if (isNaN(newStorage) || newStorage < 0) return res.status(400).json({ error: '올바른 수량을 입력해주세요.' });

    const oldStorage = item.storage_quantity || 0;
    if (oldStorage === newStorage) return res.json({ success: true, unchanged: true });

    // Update storage_quantity directly
    await pool.query(`
      UPDATE module_inventory
      SET storage_quantity = $1,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $2
    `, [newStorage, req.params.id]);

    // Recalculate total/spare based on new storage
    await ModuleInventory.recalculateInUse();

    const updated = await ModuleInventory.findById(req.params.id);

    // Log the change — BUG-1: notes 하드코딩 (v1 faithful)
    await ModuleInventoryLog.create({
      item_code: item.item_code,
      event_type: 'adjust',
      quantity_change: newStorage - oldStorage,
      user_id: req.session ? req.session.userId : null,
      username: req.session ? (req.session.displayName || req.session.username) : null,
      notes: '장비실 보관 수량 직접 수정: ' + oldStorage + '개 → ' + newStorage + '개'
    });

    await AuditLog.log(req, {
      action: 'update',
      targetType: 'module_inventory',
      targetId: req.params.id,
      targetLabel: item.item_code,
      details: { field: 'storage_quantity', oldValue: oldStorage, newValue: newStorage, total: updated.total_quantity }
    });

    res.json({
      success: true,
      storage_quantity: updated.storage_quantity,
      total_quantity: updated.total_quantity,
      spare_quantity: updated.spare_quantity,
      in_use_quantity: updated.in_use_quantity
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// EP#7: API: transfer module between assets
router.post('/modules/:id/transfer', requireMaintenance, async (req, res) => {
  try {
    const mod = await ComputingModule.findById(req.params.id);
    if (!mod) return res.status(404).json({ error: '부품을 찾을 수 없습니다.' });

    const { to_asset_id, reason } = req.body;
    if (!to_asset_id) return res.status(400).json({ error: '이동 대상 서버를 선택해주세요.' });

    const fromAsset = mod.asset_id ? await Asset.findById(mod.asset_id) : null;
    const toAsset = await Asset.findById(to_asset_id);
    if (!toAsset) return res.status(404).json({ error: '대상 서버를 찾을 수 없습니다.' });

    const fromLabel = fromAsset ? (fromAsset.management_number || fromAsset.model_name || String(mod.asset_id)) : '재고';
    const toLabel = toAsset.management_number || toAsset.model_name || String(to_asset_id);

    // Update module's asset_id
    const updated = {
      asset_id: to_asset_id,
      module_type: mod.module_type,
      model: mod.model,
      manufacturer: mod.manufacturer,
      capacity: mod.capacity,
      count: mod.count,
      specification: mod.specification,
      slot_info: mod.slot_info,
      notes: mod.notes,
      owner: mod.owner,
      owner_vendor_id: mod.owner_vendor_id
    };
    await ComputingModule.update(req.params.id, updated);

    // §5 스텁: EUL 동기 제거, recalculateInUse만
    if (mod.asset_id) await syncModulesToUsageLog(mod.asset_id);
    await syncModulesToUsageLog(to_asset_id);

    // Log transfer
    await ModuleTransferLog.create({
      module_type: mod.module_type,
      model: mod.model,
      capacity: mod.capacity,
      count: mod.count,
      owner: mod.owner,
      owner_vendor_id: mod.owner_vendor_id,
      from_asset_id: mod.asset_id || null,
      from_asset_label: fromLabel,
      to_asset_id: parseInt(to_asset_id),
      to_asset_label: toLabel,
      reason: reason || null,
      user_id: req.session ? req.session.userId : null,
      username: req.session ? (req.session.displayName || req.session.username) : null
    });

    // Log to inventory log if company module
    if ((!mod.owner || mod.owner === 'company') && mod.specification) {
      if (mod.asset_id) {
        await ModuleInventoryLog.create({
          item_code: mod.specification,
          event_type: 'removed',
          quantity_change: parseInt(mod.count) || 1,
          asset_id: mod.asset_id,
          asset_label: fromLabel,
          user_id: req.session ? req.session.userId : null,
          username: req.session ? (req.session.displayName || req.session.username) : null,
          notes: '이동: ' + fromLabel + ' → ' + toLabel
        });
      }
      await ModuleInventoryLog.create({
        item_code: mod.specification,
        event_type: 'installed',
        quantity_change: -(parseInt(mod.count) || 1),
        asset_id: parseInt(to_asset_id),
        asset_label: toLabel,
        user_id: req.session ? req.session.userId : null,
        username: req.session ? (req.session.displayName || req.session.username) : null,
        notes: '이동: ' + fromLabel + ' → ' + toLabel
      });
    }

    await AuditLog.log(req, {
      action: 'transfer',
      targetType: 'computing_module',
      targetId: req.params.id,
      targetLabel: mod.module_type + ' ' + (mod.model || ''),
      details: { from: fromLabel, to: toLabel, reason }
    });

    res.json({ success: true, from: fromLabel, to: toLabel });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// EP#8: API: get assets list for transfer dropdown
router.get('/api/assets', async (req, res) => {
  try {
    const servers = await Asset.findAll({ asset_type: 'server' });
    const storages = await Asset.findAll({ asset_type: 'storage' });
    const assets = [].concat(servers, storages);
    const result = assets.map(a => ({
      id: a.id,
      label: (a.management_number || a.asset_number || '') + ' - ' + (a.model_name || 'ID:' + a.id)
    }));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// EP#9: API: next code info for a module type
router.get('/api/next-code/:type', async (req, res) => {
  try {
    const info = await ModuleInventory.getNextCodeInfo(req.params.type);
    if (!info) return res.status(400).json({ error: '알 수 없는 모듈 유형' });
    res.json(info);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// EP#10: New module form
router.get('/modules/new', async (req, res) => {
  try {
    const servers = await Asset.findAll({ asset_type: 'server' });
    const storages = await Asset.findAll({ asset_type: 'storage' });
    const assets = [].concat(servers, storages);
    const preselectedAssetId = req.query.asset_id;
    const inventoryItems = await ModuleInventory.findAll();
    const vendors = await Vendor.findAll();
    res.render('module-inventory/modules-form', {
      title: '모듈 등록',
      currentPath: '/module-inventory',
      extraCss: null,
      extraJs: null,
      module: null,
      assets,
      preselectedAssetId,
      inventoryItems,
      vendors,
      appConfig
    });
  } catch (err) {
    req.flash('error', '폼 로드 실패: ' + err.message);
    res.redirect('/module-inventory');
  }
});

// EP#11: Create module
router.post('/modules', requireMaintenance, async (req, res) => {
  try {
    const modId = await ComputingModule.create(req.body);

    // 모듈 설치: storage 감소 + 이력 기록
    if (req.body.asset_id) {
      const installCount = parseInt(req.body.count) || 1;
      if (req.body.specification) {
        const inv = await ModuleInventory.findByCode(req.body.specification);
        if (inv && inv.storage_quantity >= installCount) {
          await pool.query(`
            UPDATE module_inventory
            SET storage_quantity = storage_quantity - $1,
                updated_at = CURRENT_TIMESTAMP
            WHERE item_code = $2
          `, [installCount, req.body.specification]);
        }

        const asset = await Asset.findById(req.body.asset_id);
        await ModuleInventoryLog.create({
          item_code: req.body.specification,
          event_type: 'installed',
          quantity_change: -installCount,
          asset_id: parseInt(req.body.asset_id),
          asset_label: asset ? (asset.management_number || asset.asset_number || String(req.body.asset_id)) : null,
          user_id: req.session ? req.session.userId : null,
          username: req.session ? (req.session.displayName || req.session.username) : null,
          notes: req.body.module_type + ' 모듈 설치'
        });
      }

      // §5 스텁: recalculateInUse만
      await syncModulesToUsageLog(req.body.asset_id);
    }

    const createAsset = req.body.asset_id ? await Asset.findById(req.body.asset_id) : null;
    const createServerName = createAsset ? (createAsset.management_number || createAsset.model_name || '') : '';
    await AuditLog.log(req, { action: 'create', targetType: 'computing_module', targetId: modId, targetLabel: '[' + createServerName + '] ' + req.body.module_type + ' ' + (req.body.model || ''), details: { server: createServerName, module_type: req.body.module_type, model: req.body.model, manufacturer: req.body.manufacturer, capacity: req.body.capacity, specification: req.body.specification, count: req.body.count, slot_info: req.body.slot_info } });
    req.flash('success', '모듈이 등록되었습니다.');
    if (req.body.returnTo) {
      return res.redirect(req.body.returnTo);
    }
    if (req.body.asset_id) {
      return res.redirect('/assets/' + req.body.asset_id);
    }
    res.redirect('/module-inventory?tab=installed');
  } catch (err) {
    req.flash('error', '등록 실패: ' + err.message);
    res.redirect('/module-inventory/modules/new');
  }
});

// EP#12: Edit module form
router.get('/modules/:id/edit', async (req, res) => {
  try {
    const mod = await ComputingModule.findById(req.params.id);
    if (!mod) {
      req.flash('error', '모듈을 찾을 수 없습니다.');
      return res.redirect('/module-inventory?tab=installed');
    }
    const servers = await Asset.findAll({ asset_type: 'server' });
    const storages = await Asset.findAll({ asset_type: 'storage' });
    const assets = [].concat(servers, storages);
    const inventoryItems = await ModuleInventory.findAll();
    const vendors = await Vendor.findAll();
    res.render('module-inventory/modules-form', {
      title: '모듈 수정',
      currentPath: '/module-inventory',
      extraCss: null,
      extraJs: null,
      module: mod,
      assets,
      preselectedAssetId: null,
      inventoryItems,
      vendors,
      appConfig,
      returnTo: req.query.returnTo || req.get('Referer') || ''
    });
  } catch (err) {
    req.flash('error', '폼 로드 실패: ' + err.message);
    res.redirect('/module-inventory?tab=installed');
  }
});

// EP#13: Update module
router.post('/modules/:id', requireMaintenance, async (req, res) => {
  try {
    const beforeMod = await ComputingModule.findById(req.params.id);
    await ComputingModule.update(req.params.id, req.body);

    // Recalculate inventory
    const assetId = req.body.asset_id || (beforeMod && beforeMod.asset_id);
    if (assetId) {
      // 모듈 수정: storage_quantity 조정 (recalculateInUse 전에 실행해야 total이 정확함)
      if (beforeMod) {
        const asset = await Asset.findById(assetId);
        const assetLabel = asset ? (asset.management_number || asset.asset_number || String(assetId)) : null;
        const specChanged = req.body.specification && beforeMod.specification !== req.body.specification;
        const countChanged = String(beforeMod.count) !== String(req.body.count);
        const itemCode = req.body.specification || beforeMod.specification;
        const oldCount = parseInt(beforeMod.count) || 1;
        const newCount = parseInt(req.body.count) || 1;

        if (specChanged) {
          // 부품코드 변경: 이전 코드 → storage 복원, 새 코드 → storage 감소
          if (beforeMod.specification) {
            await pool.query(
              'UPDATE module_inventory SET storage_quantity = storage_quantity + $1, updated_at = CURRENT_TIMESTAMP WHERE item_code = $2',
              [oldCount, beforeMod.specification]
            );
            await ModuleInventoryLog.create({
              item_code: beforeMod.specification,
              event_type: 'removed',
              quantity_change: oldCount,
              asset_id: parseInt(assetId),
              asset_label: assetLabel,
              notes: '부품코드 변경으로 제거 (' + beforeMod.specification + ' → ' + req.body.specification + ')'
            });
          }
          if (req.body.specification) {
            await pool.query(
              'UPDATE module_inventory SET storage_quantity = GREATEST(storage_quantity - $1, 0), updated_at = CURRENT_TIMESTAMP WHERE item_code = $2',
              [newCount, req.body.specification]
            );
            await ModuleInventoryLog.create({
              item_code: req.body.specification,
              event_type: 'installed',
              quantity_change: -newCount,
              asset_id: parseInt(assetId),
              asset_label: assetLabel,
              notes: '부품코드 변경으로 설치 (' + (beforeMod.specification || '-') + ' → ' + req.body.specification + ')'
            });
          }
        } else if (countChanged && itemCode) {
          // 수량 변경: 차이만큼 storage 조정 (증가하면 storage 감소, 감소하면 storage 증가)
          const diff = newCount - oldCount;
          if (diff > 0) {
            await pool.query(
              'UPDATE module_inventory SET storage_quantity = GREATEST(storage_quantity - $1, 0), updated_at = CURRENT_TIMESTAMP WHERE item_code = $2',
              [diff, itemCode]
            );
          } else if (diff < 0) {
            await pool.query(
              'UPDATE module_inventory SET storage_quantity = storage_quantity + $1, updated_at = CURRENT_TIMESTAMP WHERE item_code = $2',
              [-diff, itemCode]
            );
          }
          await ModuleInventoryLog.create({
            item_code: itemCode,
            event_type: 'adjust',
            quantity_change: diff,
            asset_id: parseInt(assetId),
            asset_label: assetLabel,
            notes: '수량 변경: ' + oldCount + '개 → ' + newCount + '개'
          });
        }
      }

      // §5 스텁: recalculateInUse만
      await syncModulesToUsageLog(assetId);
      // If asset changed, also sync old asset
      if (beforeMod && beforeMod.asset_id && String(beforeMod.asset_id) !== String(assetId)) {
        await syncModulesToUsageLog(beforeMod.asset_id);
      }
    }

    // Build detailed change log for audit
    const changedFields = {};
    if (beforeMod) {
      const trackFields = ['module_type', 'model', 'manufacturer', 'capacity', 'count', 'specification', 'slot_info', 'notes', 'asset_id'];
      for (const f of trackFields) {
        if (String(beforeMod[f] || '') !== String(req.body[f] || '')) {
          changedFields[f] = { from: beforeMod[f] || null, to: req.body[f] || null };
        }
      }
      // owner defaults to 'company'
      const beforeOwner = beforeMod.owner || 'company';
      const afterOwner = req.body.owner || 'company';
      if (beforeOwner !== afterOwner) {
        changedFields.owner = { from: beforeOwner, to: afterOwner };
      }
    }
    const updateAsset = await Asset.findById(assetId);
    const updateServerName = updateAsset ? (updateAsset.management_number || updateAsset.model_name || '') : '';
    await AuditLog.log(req, { action: 'update', targetType: 'computing_module', targetId: req.params.id, targetLabel: '[' + updateServerName + '] ' + req.body.module_type + ' ' + (req.body.model || ''), details: { server: updateServerName, changes: changedFields } });
    req.flash('success', '모듈이 수정되었습니다.');
    if (req.body.returnTo) {
      return res.redirect(req.body.returnTo);
    }
    if (req.body.asset_id) {
      return res.redirect('/assets/' + req.body.asset_id);
    }
    res.redirect('/module-inventory?tab=installed');
  } catch (err) {
    req.flash('error', '수정 실패: ' + err.message);
    res.redirect('/module-inventory/modules/' + req.params.id + '/edit');
  }
});

// EP#14: Inline update module field (AJAX)
router.post('/modules/:id/inline-update', requireMaintenance, async (req, res) => {
  try {
    const mod = await ComputingModule.findById(req.params.id);
    if (!mod) return res.status(404).json({ error: '부품을 찾을 수 없습니다.' });

    const { field, value } = req.body;
    const allowedFields = ['model', 'manufacturer', 'capacity', 'specification', 'slot_info', 'count', 'notes'];
    if (!allowedFields.includes(field)) {
      return res.status(400).json({ error: '수정할 수 없는 필드입니다: ' + field });
    }

    // Build updated data from existing module
    const updated = {
      asset_id: mod.asset_id,
      module_type: mod.module_type,
      model: mod.model,
      manufacturer: mod.manufacturer,
      capacity: mod.capacity,
      count: mod.count,
      specification: mod.specification,
      slot_info: mod.slot_info,
      notes: mod.notes,
      owner: mod.owner,
      owner_vendor_id: mod.owner_vendor_id
    };
    updated[field] = value;

    await ComputingModule.update(req.params.id, updated);

    // Sync to usage log and recalculate inventory
    if (mod.asset_id) {
      await syncModulesToUsageLog(mod.asset_id);

      // Log if specification or count changed (company modules only)
      const isCompanyInline = (!mod.owner || mod.owner === 'company');
      if (isCompanyInline && (field === 'specification' || field === 'count') && String(mod[field]) !== String(value)) {
        const asset = await Asset.findById(mod.asset_id);
        const assetLabel = asset ? (asset.management_number || asset.asset_number || String(mod.asset_id)) : null;

        if (field === 'count' && mod.specification) {
          const oldCount = parseInt(mod.count) || 0;
          const newCount = parseInt(value) || 0;
          await ModuleInventoryLog.create({
            item_code: mod.specification,
            event_type: 'adjust',
            quantity_change: newCount - oldCount,
            asset_id: mod.asset_id,
            asset_label: assetLabel,
            user_id: req.session ? req.session.userId : null,
            username: req.session ? (req.session.displayName || req.session.username) : null,
            notes: '수량 변경: ' + oldCount + '개 → ' + newCount + '개'
          });
        } else if (field === 'specification') {
          if (mod.specification) {
            await ModuleInventoryLog.create({
              item_code: mod.specification,
              event_type: 'removed',
              quantity_change: parseInt(mod.count) || 1,
              asset_id: mod.asset_id,
              asset_label: assetLabel,
              user_id: req.session ? req.session.userId : null,
              username: req.session ? (req.session.displayName || req.session.username) : null,
              notes: '부품코드 변경으로 제거 (' + mod.specification + ' → ' + value + ')'
            });
          }
          if (value) {
            await ModuleInventoryLog.create({
              item_code: value,
              event_type: 'installed',
              quantity_change: -(parseInt(mod.count) || 1),
              asset_id: mod.asset_id,
              asset_label: assetLabel,
              user_id: req.session ? req.session.userId : null,
              username: req.session ? (req.session.displayName || req.session.username) : null,
              notes: '부품코드 변경으로 설치 (' + (mod.specification || '-') + ' → ' + value + ')'
            });
          }
        }
      }
    }

    const inlineAsset = await Asset.findById(mod.asset_id);
    const inlineServerName = inlineAsset ? (inlineAsset.management_number || inlineAsset.model_name || '') : '';
    await AuditLog.log(req, {
      action: 'update',
      targetType: 'computing_module',
      targetId: req.params.id,
      targetLabel: '[' + inlineServerName + '] ' + updated.module_type + ' ' + (updated.model || ''),
      details: { server: inlineServerName, field, oldValue: mod[field], newValue: value }
    });

    res.json({ success: true, field, value });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// EP#15: Delete module
router.post('/modules/:id/delete', requireMaintenance, async (req, res) => {
  const mod = await ComputingModule.findById(req.params.id);
  try {
    await ComputingModule.delete(req.params.id);

    // 자사 모듈 제거: storage 증가를 recalculateInUse 전에 실행해야 total이 정확함
    if (mod && mod.asset_id) {
      const isCompanyDelete = (!mod.owner || mod.owner === 'company');
      const removeCount = parseInt(mod.count) || 1;
      if (mod.specification && isCompanyDelete) {
        await pool.query(`
          UPDATE module_inventory
          SET storage_quantity = storage_quantity + $1,
              updated_at = CURRENT_TIMESTAMP
          WHERE item_code = $2
        `, [removeCount, mod.specification]);

        const asset = await Asset.findById(mod.asset_id);
        await ModuleInventoryLog.create({
          item_code: mod.specification,
          event_type: 'removed',
          quantity_change: removeCount,
          asset_id: mod.asset_id,
          asset_label: asset ? (asset.management_number || asset.asset_number || String(mod.asset_id)) : null,
          user_id: req.session ? req.session.userId : null,
          username: req.session ? (req.session.displayName || req.session.username) : null,
          notes: mod.module_type + ' 모듈 제거 → 장비실'
        });
      }

      // §5 스텁: recalculateInUse만
      await syncModulesToUsageLog(mod.asset_id);
    }

    const delAsset = mod && mod.asset_id ? await Asset.findById(mod.asset_id) : null;
    const delServerName = delAsset ? (delAsset.management_number || delAsset.model_name || '') : '';
    await AuditLog.log(req, { action: 'delete', targetType: 'computing_module', targetId: req.params.id, targetLabel: mod ? ('[' + delServerName + '] ' + mod.module_type + ' ' + (mod.model || '')) : req.params.id, details: mod ? { server: delServerName, module_type: mod.module_type, model: mod.model, manufacturer: mod.manufacturer, capacity: mod.capacity, specification: mod.specification, count: mod.count, slot_info: mod.slot_info } : null });
    req.flash('success', '모듈이 삭제되었습니다.');
  } catch (err) {
    req.flash('error', '삭제 실패: ' + err.message);
  }
  const returnTo = req.body.returnTo || req.get('Referer');
  if (returnTo) return res.redirect(returnTo);
  if (mod && mod.asset_id) {
    return res.redirect('/assets/' + mod.asset_id);
  }
  res.redirect('/module-inventory?tab=installed');
});

// EP#16: API: return vendor parts (업체 부품 반납)
router.post('/api/inventory/:id/return-vendor', requireMaintenance, async (req, res) => {
  try {
    const item = await ModuleInventory.findById(req.params.id);
    if (!item) return res.status(404).json({ error: '부품을 찾을 수 없습니다.' });
    if (item.owner !== 'vendor') return res.status(400).json({ error: '업체 부품만 반납할 수 있습니다.' });

    const beforeTotal = item.total_quantity;
    const beforeSpare = item.spare_quantity;

    // Find affected computing_modules (installed on assets) matching this item_code + vendor
    const { rows: installedModules } = await pool.query(`
      SELECT cm.id, cm.asset_id, cm.count
      FROM computing_modules cm
      WHERE cm.specification = $1 AND cm.owner = 'vendor'
    `, [item.item_code]);

    // Also find by module_type + model fallback
    const { rows: fallbackModules } = await pool.query(`
      SELECT cm.id, cm.asset_id, cm.count
      FROM computing_modules cm
      WHERE (cm.specification IS NULL OR cm.specification = '')
        AND cm.module_type = $1 AND cm.model = $2 AND cm.owner = 'vendor'
    `, [item.module_type, item.model]);

    const allModules = [...installedModules, ...fallbackModules];
    const affectedAssetIds = [...new Set(allModules.map(m => m.asset_id).filter(Boolean))];

    // Delete vendor computing_modules
    for (const m of allModules) {
      await pool.query('DELETE FROM computing_modules WHERE id = $1', [m.id]);
    }

    // Set quantities to 0
    await pool.query(`
      UPDATE module_inventory
      SET storage_quantity = 0, total_quantity = 0, spare_quantity = 0, in_use_quantity = 0,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
    `, [req.params.id]);

    // Log outgoing event
    await ModuleInventoryLog.create({
      item_code: item.item_code,
      event_type: 'outgoing',
      quantity_change: -beforeTotal,
      before_total: beforeTotal,
      after_total: 0,
      before_spare: beforeSpare,
      after_spare: 0,
      user_id: req.session ? req.session.userId : null,
      username: req.session ? (req.session.displayName || req.session.username) : null,
      notes: '업체 부품 반납 (전량)'
    });

    // §5 스텁: recalculateInUse만
    for (const assetId of affectedAssetIds) {
      await syncModulesToUsageLog(assetId);
    }

    await AuditLog.log(req, {
      action: 'update',
      targetType: 'module_inventory',
      targetId: req.params.id,
      targetLabel: item.item_code,
      details: {
        event: 'vendor_return',
        beforeTotal,
        deletedModules: allModules.length,
        affectedAssets: affectedAssetIds.length
      }
    });

    res.json({
      success: true,
      item_code: item.item_code,
      deleted_modules: allModules.length,
      affected_assets: affectedAssetIds.length
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.syncModulesToUsageLog = syncModulesToUsageLog;
module.exports = router;
