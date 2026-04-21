const express = require('express');
const router = express.Router();
const ModuleInventory = require('../models/moduleInventory');
const ModuleInventoryLog = require('../models/moduleInventoryLog');
const EquipmentUsageLog = require('../models/equipmentUsageLog');
const ComputingModule = require('../models/computingModule');
const Asset = require('../models/asset');
const Vendor = require('../models/vendor');
const appConfig = require('../config/app');
const { requireMaintenance } = require('../middleware/auth');
const AuditLog = require('../models/auditLog');

// Sync computing modules to equipment_usage_logs hardware columns
function syncModulesToUsageLog(assetId) {
  const asset = Asset.findById(assetId);
  if (!asset || !asset.management_number) return;

  const allModules = ComputingModule.findByAsset(assetId);
  // Only company-owned modules go into equipment_usage_logs hardware columns
  const modules = allModules.filter(m => m.owner !== 'vendor');

  // Group modules by type
  const grouped = {};
  for (const m of modules) {
    if (!grouped[m.module_type]) grouped[m.module_type] = [];
    grouped[m.module_type].push(m);
  }

  // Build hardware data from modules
  const hw = {};

  // CPU → cpu_type/cpu_num
  const cpus = grouped['cpu'] || [];
  if (cpus.length > 0) {
    hw.cpu_type = cpus[0].specification || cpus[0].model || null;
    hw.cpu_num = cpus.reduce((sum, c) => sum + (parseInt(c.count) || 0), 0) || null;
  } else {
    hw.cpu_type = null; hw.cpu_num = null;
  }

  // Memory → mem1/mem2 (max 2 slots)
  const mems = grouped['memory'] || [];
  for (let i = 0; i < 2; i++) {
    const key = 'mem' + (i + 1);
    if (mems[i]) {
      hw[key + '_type'] = mems[i].specification || mems[i].model || null;
      hw[key + '_num'] = parseInt(mems[i].count) || null;
    } else {
      hw[key + '_type'] = null; hw[key + '_num'] = null;
    }
  }

  // Disk → disk1~disk4 (max 4 slots)
  const disks = grouped['disk'] || [];
  for (let i = 0; i < 4; i++) {
    const key = 'disk' + (i + 1);
    if (disks[i]) {
      hw[key + '_part'] = disks[i].specification || disks[i].model || null;
      hw[key + '_num'] = parseInt(disks[i].count) || null;
    } else {
      hw[key + '_part'] = null; hw[key + '_num'] = null;
    }
  }

  // Network → nic1~nic4 (max 4 slots)
  const nics = (grouped['network'] || []).filter(n => !n.is_onboard);
  for (let i = 0; i < 4; i++) {
    const key = 'nic' + (i + 1);
    if (nics[i]) {
      hw[key + '_type'] = nics[i].specification || nics[i].model || null;
      hw[key + '_num'] = parseInt(nics[i].count) || null;
    } else {
      hw[key + '_type'] = null; hw[key + '_num'] = null;
    }
  }

  // RAID → raid_type/raid_num
  const raids = grouped['raid'] || [];
  if (raids.length > 0) {
    hw.raid_type = raids[0].specification || raids[0].model || null;
    hw.raid_num = raids.reduce((sum, r) => sum + (parseInt(r.count) || 0), 0) || null;
  } else {
    hw.raid_type = null; hw.raid_num = null;
  }

  // GPU → gpu1/gpu2 (max 2 slots)
  const gpus = grouped['gpu'] || [];
  for (let i = 0; i < 2; i++) {
    const key = 'gpu' + (i + 1);
    if (gpus[i]) {
      hw[key + '_type'] = gpus[i].specification || gpus[i].model || null;
      hw[key + '_num'] = parseInt(gpus[i].count) || null;
    } else {
      hw[key + '_type'] = null; hw[key + '_num'] = null;
    }
  }

  const updated = EquipmentUsageLog.updateHardwareColumns(asset.management_number, hw);
  if (updated === null) {
    // 사용중 기록이 없으면 자동 생성
    EquipmentUsageLog.create({
      management_number: asset.management_number,
      model_name: asset.model_name || null,
      asset_number: asset.asset_number || null,
      room: asset.room_name || null,
      rack: asset.rack_name || null,
      status: '사용중',
      ownership: asset.ownership || 'company',
      ...hw
    });
  }
  ModuleInventory.recalculateInUse();
}

// Integrated main page (tabs: inventory + installed + history)
router.get('/', (req, res) => {
  const tab = req.query.tab || 'inventory';
  const selectedType = req.query.type || '';
  const statsByType = ModuleInventory.getStatsByType();
  let items = ModuleInventory.findAll(selectedType || undefined);

  // Apply spare_only filter
  const spareOnly = req.query.spare_only === '1';
  if (spareOnly) {
    items = items.filter(item => item.spare_quantity > 0);
  }

  // Installed modules data
  const filters = {
    module_type: req.query.module_type,
    asset_id: req.query.asset_id,
    search: req.query.search
  };
  const modules = ComputingModule.findAll(filters);

  // History tab data
  const historyFilters = {
    event_type: req.query.event_type,
    item_code: req.query.item_code,
    date_from: req.query.date_from,
    date_to: req.query.date_to,
    search: req.query.hist_search
  };
  const historyLogs = tab === 'history' ? ModuleInventoryLog.findAll(historyFilters) : [];

  // All item codes for history filter dropdown
  const allItemCodes = tab === 'history' ? ModuleInventory.findAll().map(i => i.item_code).filter(Boolean) : [];

  res.render('module-inventory/index', {
    title: '부품 현황',
    currentPath: '/module-inventory',
    extraCss: null,
    extraJs: null,
    tab,
    statsByType,
    items,
    selectedType,
    spareOnly,
    modules,
    filters,
    historyLogs,
    historyFilters,
    allItemCodes,
    appConfig
  });
});

// API: get usage details for a component code
router.get('/api/usage/:code', (req, res) => {
  const code = req.params.code;
  const spec = ModuleInventory.findByCode(code);
  const usage = ModuleInventory.getUsageByCode(code);
  res.json({ spec, usage });
});

// API: get history logs for a component code
router.get('/api/history/:code', (req, res) => {
  try {
    const code = req.params.code;
    const limit = parseInt(req.query.limit) || 100;
    const logs = ModuleInventoryLog.findByItemCode(code, limit);
    res.json({ logs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Inline update module_inventory field (AJAX) + sync to computing_modules
router.post('/api/inventory/:id/inline-update', requireMaintenance, (req, res) => {
  try {
    const item = ModuleInventory.findById(req.params.id);
    if (!item) return res.status(404).json({ error: '부품을 찾을 수 없습니다.' });

    const { field, value } = req.body;
    const oldValue = item[field];

    ModuleInventory.updateField(req.params.id, field, value);

    // Sync to computing_modules: match by module_type + old field value
    let syncCount = 0;
    const syncFields = ['model', 'manufacturer', 'capacity'];
    if (syncFields.includes(field) && oldValue) {
      const { getDb } = require('../config/database');
      const db = getDb();
      const result = db.prepare(
        `UPDATE computing_modules SET ${field} = ?, updated_at = CURRENT_TIMESTAMP
         WHERE module_type = ? AND ${field} = ?`
      ).run(value || null, item.module_type, oldValue);
      syncCount = result.changes;
    }

    AuditLog.log(req, {
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

// API: adjust inventory quantity (incoming/outgoing)
router.post('/api/inventory/:id/adjust', requireMaintenance, (req, res) => {
  try {
    const item = ModuleInventory.findById(req.params.id);
    if (!item) return res.status(404).json({ error: '부품을 찾을 수 없습니다.' });

    const { quantity_change, event_type, asset_number, notes } = req.body;
    const qty = parseInt(quantity_change);
    if (!qty || qty === 0) return res.status(400).json({ error: '수량을 입력해주세요.' });

    const result = ModuleInventory.adjustQuantity(req.params.id, qty);

    // Log the event
    ModuleInventoryLog.create({
      item_code: item.item_code,
      event_type: event_type || (qty > 0 ? 'incoming' : 'outgoing'),
      quantity_change: qty,
      before_total: result.before_total,
      after_total: result.after_total,
      before_spare: result.before_spare,
      after_spare: result.after_spare,
      asset_number: asset_number || null,
      user_id: req.user ? req.user.id : null,
      username: req.user ? (req.user.display_name || req.user.username) : null,
      notes: notes || null
    });

    AuditLog.log(req, {
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

// API: transfer module between assets
router.post('/modules/:id/transfer', requireMaintenance, (req, res) => {
  try {
    const mod = ComputingModule.findById(req.params.id);
    if (!mod) return res.status(404).json({ error: '모듈을 찾을 수 없습니다.' });

    const { to_asset_id, reason } = req.body;
    if (!to_asset_id) return res.status(400).json({ error: '이동 대상 서버를 선택해주세요.' });

    const fromAsset = mod.asset_id ? Asset.findById(mod.asset_id) : null;
    const toAsset = Asset.findById(to_asset_id);
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
    ComputingModule.update(req.params.id, updated);

    // Sync both old and new assets
    if (mod.asset_id) syncModulesToUsageLog(mod.asset_id);
    syncModulesToUsageLog(to_asset_id);

    // Log transfer
    const ModuleTransferLog = require('../models/moduleTransferLog');
    ModuleTransferLog.create({
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
      user_id: req.user ? req.user.id : null,
      username: req.user ? (req.user.display_name || req.user.username) : null
    });

    // Log to inventory log if company module
    if ((!mod.owner || mod.owner === 'company') && mod.specification) {
      if (mod.asset_id) {
        ModuleInventoryLog.create({
          item_code: mod.specification,
          event_type: 'removed',
          quantity_change: parseInt(mod.count) || 1,
          asset_id: mod.asset_id,
          asset_label: fromLabel,
          user_id: req.user ? req.user.id : null,
          username: req.user ? (req.user.display_name || req.user.username) : null,
          notes: '이동: ' + fromLabel + ' → ' + toLabel
        });
      }
      ModuleInventoryLog.create({
        item_code: mod.specification,
        event_type: 'installed',
        quantity_change: -(parseInt(mod.count) || 1),
        asset_id: parseInt(to_asset_id),
        asset_label: toLabel,
        user_id: req.user ? req.user.id : null,
        username: req.user ? (req.user.display_name || req.user.username) : null,
        notes: '이동: ' + fromLabel + ' → ' + toLabel
      });
    }

    AuditLog.log(req, {
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

// API: get assets list for transfer dropdown
router.get('/api/assets', (req, res) => {
  try {
    const assets = [].concat(Asset.findAll({ asset_type: 'server' }), Asset.findAll({ asset_type: 'storage' }));
    const result = assets.map(a => ({
      id: a.id,
      label: (a.management_number || a.asset_number || '') + ' - ' + (a.model_name || 'ID:' + a.id)
    }));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Computing Module CRUD ---

// API: next code info for a module type
router.get('/api/next-code/:type', (req, res) => {
  try {
    const info = ModuleInventory.getNextCodeInfo(req.params.type);
    if (!info) return res.status(400).json({ error: '알 수 없는 모듈 유형' });
    res.json(info);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// New module form
router.get('/modules/new', (req, res) => {
  const assets = [].concat(Asset.findAll({ asset_type: 'server' }), Asset.findAll({ asset_type: 'storage' }));
  const preselectedAssetId = req.query.asset_id;
  const inventoryItems = ModuleInventory.findAll();
  const vendors = Vendor.findAll();
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
});

// Create module
router.post('/modules', requireMaintenance, (req, res) => {
  try {
    const modId = ComputingModule.create(req.body);

    // Sync to usage log and recalculate inventory
    if (req.body.asset_id) {
      syncModulesToUsageLog(req.body.asset_id);

      // Log installed event (company modules only)
      const isCompanyModule = !req.body.owner || req.body.owner === 'company';
      if (req.body.specification && isCompanyModule) {
        const asset = Asset.findById(req.body.asset_id);
        ModuleInventoryLog.create({
          item_code: req.body.specification,
          event_type: 'installed',
          quantity_change: -(parseInt(req.body.count) || 1),
          asset_id: parseInt(req.body.asset_id),
          asset_label: asset ? (asset.management_number || asset.asset_number || String(req.body.asset_id)) : null,
          user_id: req.user ? req.user.id : null,
          username: req.user ? (req.user.display_name || req.user.username) : null,
          notes: req.body.module_type + ' 모듈 설치'
        });
      }
    }

    const createAsset = req.body.asset_id ? Asset.findById(req.body.asset_id) : null;
    const createServerName = createAsset ? (createAsset.management_number || createAsset.model_name || '') : '';
    AuditLog.log(req, { action: 'create', targetType: 'computing_module', targetId: modId, targetLabel: '[' + createServerName + '] ' + req.body.module_type + ' ' + (req.body.model || ''), details: { server: createServerName, module_type: req.body.module_type, model: req.body.model, manufacturer: req.body.manufacturer, capacity: req.body.capacity, specification: req.body.specification, count: req.body.count, slot_info: req.body.slot_info } });
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

// Edit module form
router.get('/modules/:id/edit', (req, res) => {
  const mod = ComputingModule.findById(req.params.id);
  if (!mod) {
    req.flash('error', '모듈을 찾을 수 없습니다.');
    return res.redirect('/module-inventory?tab=installed');
  }
  const assets = [].concat(Asset.findAll({ asset_type: 'server' }), Asset.findAll({ asset_type: 'storage' }));
  const inventoryItems = ModuleInventory.findAll();
  const vendors = Vendor.findAll();
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
});

// Update module
router.post('/modules/:id', requireMaintenance, (req, res) => {
  try {
    const beforeMod = ComputingModule.findById(req.params.id);
    ComputingModule.update(req.params.id, req.body);

    // Sync to usage log and recalculate inventory
    const assetId = req.body.asset_id || (beforeMod && beforeMod.asset_id);
    if (assetId) {
      syncModulesToUsageLog(assetId);
      // If asset changed, also sync old asset
      if (beforeMod && beforeMod.asset_id && String(beforeMod.asset_id) !== String(assetId)) {
        syncModulesToUsageLog(beforeMod.asset_id);
      }

      // Log changes to module_inventory_logs (company modules only)
      const isCompanyUpdate = (!req.body.owner || req.body.owner === 'company');
      if (beforeMod && isCompanyUpdate) {
        const asset = Asset.findById(assetId);
        const assetLabel = asset ? (asset.management_number || asset.asset_number || String(assetId)) : null;
        const specChanged = req.body.specification && beforeMod.specification !== req.body.specification;
        const countChanged = String(beforeMod.count) !== String(req.body.count);
        const itemCode = req.body.specification || beforeMod.specification;

        if (specChanged) {
          // Specification changed: log removed (old) + installed (new)
          if (beforeMod.specification) {
            ModuleInventoryLog.create({
              item_code: beforeMod.specification,
              event_type: 'removed',
              quantity_change: parseInt(beforeMod.count) || 1,
              asset_id: parseInt(assetId),
              asset_label: assetLabel,
              user_id: req.user ? req.user.id : null,
              username: req.user ? (req.user.display_name || req.user.username) : null,
              notes: '부품코드 변경으로 제거 (' + beforeMod.specification + ' → ' + req.body.specification + ')'
            });
          }
          if (req.body.specification) {
            ModuleInventoryLog.create({
              item_code: req.body.specification,
              event_type: 'installed',
              quantity_change: -(parseInt(req.body.count) || 1),
              asset_id: parseInt(assetId),
              asset_label: assetLabel,
              user_id: req.user ? req.user.id : null,
              username: req.user ? (req.user.display_name || req.user.username) : null,
              notes: '부품코드 변경으로 설치 (' + (beforeMod.specification || '-') + ' → ' + req.body.specification + ')'
            });
          }
        } else if (countChanged && itemCode) {
          // Count changed (same specification): log quantity adjustment
          const oldCount = parseInt(beforeMod.count) || 0;
          const newCount = parseInt(req.body.count) || 0;
          const diff = newCount - oldCount;
          ModuleInventoryLog.create({
            item_code: itemCode,
            event_type: 'adjust',
            quantity_change: diff,
            asset_id: parseInt(assetId),
            asset_label: assetLabel,
            user_id: req.user ? req.user.id : null,
            username: req.user ? (req.user.display_name || req.user.username) : null,
            notes: '수량 변경: ' + oldCount + '개 → ' + newCount + '개'
          });
        }
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
    const updateAsset = Asset.findById(assetId);
    const updateServerName = updateAsset ? (updateAsset.management_number || updateAsset.model_name || '') : '';
    AuditLog.log(req, { action: 'update', targetType: 'computing_module', targetId: req.params.id, targetLabel: '[' + updateServerName + '] ' + req.body.module_type + ' ' + (req.body.model || ''), details: { server: updateServerName, changes: changedFields } });
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

// Inline update module field (AJAX)
router.post('/modules/:id/inline-update', requireMaintenance, (req, res) => {
  try {
    const mod = ComputingModule.findById(req.params.id);
    if (!mod) return res.status(404).json({ error: '모듈을 찾을 수 없습니다.' });

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

    ComputingModule.update(req.params.id, updated);

    // Sync to usage log and recalculate inventory
    if (mod.asset_id) {
      syncModulesToUsageLog(mod.asset_id);

      // Log if specification or count changed (company modules only)
      const isCompanyInline = (!mod.owner || mod.owner === 'company');
      if (isCompanyInline && (field === 'specification' || field === 'count') && String(mod[field]) !== String(value)) {
        const asset = Asset.findById(mod.asset_id);
        const assetLabel = asset ? (asset.management_number || asset.asset_number || String(mod.asset_id)) : null;

        if (field === 'count' && mod.specification) {
          const oldCount = parseInt(mod.count) || 0;
          const newCount = parseInt(value) || 0;
          ModuleInventoryLog.create({
            item_code: mod.specification,
            event_type: 'adjust',
            quantity_change: newCount - oldCount,
            asset_id: mod.asset_id,
            asset_label: assetLabel,
            user_id: req.user ? req.user.id : null,
            username: req.user ? (req.user.display_name || req.user.username) : null,
            notes: '수량 변경: ' + oldCount + '개 → ' + newCount + '개'
          });
        } else if (field === 'specification') {
          if (mod.specification) {
            ModuleInventoryLog.create({
              item_code: mod.specification,
              event_type: 'removed',
              quantity_change: parseInt(mod.count) || 1,
              asset_id: mod.asset_id,
              asset_label: assetLabel,
              user_id: req.user ? req.user.id : null,
              username: req.user ? (req.user.display_name || req.user.username) : null,
              notes: '부품코드 변경으로 제거 (' + mod.specification + ' → ' + value + ')'
            });
          }
          if (value) {
            ModuleInventoryLog.create({
              item_code: value,
              event_type: 'installed',
              quantity_change: -(parseInt(mod.count) || 1),
              asset_id: mod.asset_id,
              asset_label: assetLabel,
              user_id: req.user ? req.user.id : null,
              username: req.user ? (req.user.display_name || req.user.username) : null,
              notes: '부품코드 변경으로 설치 (' + (mod.specification || '-') + ' → ' + value + ')'
            });
          }
        }
      }
    }

    const inlineAsset = Asset.findById(mod.asset_id);
    const inlineServerName = inlineAsset ? (inlineAsset.management_number || inlineAsset.model_name || '') : '';
    AuditLog.log(req, {
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

// Delete module
router.post('/modules/:id/delete', requireMaintenance, (req, res) => {
  const mod = ComputingModule.findById(req.params.id);
  try {
    ComputingModule.delete(req.params.id);

    // Sync to usage log and recalculate inventory
    if (mod && mod.asset_id) {
      syncModulesToUsageLog(mod.asset_id);

      // Log removed event (company modules only)
      const isCompanyDelete = (!mod.owner || mod.owner === 'company');
      if (mod.specification && isCompanyDelete) {
        const asset = Asset.findById(mod.asset_id);
        ModuleInventoryLog.create({
          item_code: mod.specification,
          event_type: 'removed',
          quantity_change: parseInt(mod.count) || 1,
          asset_id: mod.asset_id,
          asset_label: asset ? (asset.management_number || asset.asset_number || String(mod.asset_id)) : null,
          user_id: req.user ? req.user.id : null,
          username: req.user ? (req.user.display_name || req.user.username) : null,
          notes: mod.module_type + ' 모듈 제거'
        });
      }
    }

    const delAsset = mod && mod.asset_id ? Asset.findById(mod.asset_id) : null;
    const delServerName = delAsset ? (delAsset.management_number || delAsset.model_name || '') : '';
    AuditLog.log(req, { action: 'delete', targetType: 'computing_module', targetId: req.params.id, targetLabel: mod ? ('[' + delServerName + '] ' + mod.module_type + ' ' + (mod.model || '')) : req.params.id, details: mod ? { server: delServerName, module_type: mod.module_type, model: mod.model, manufacturer: mod.manufacturer, capacity: mod.capacity, specification: mod.specification, count: mod.count, slot_info: mod.slot_info } : null });
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

module.exports = router;
