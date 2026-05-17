const express = require('express');
const router = express.Router();
const Asset = require('../models/asset');
const Rack = require('../models/rack');
const ServerRoom = require('../models/serverRoom');
const Vendor = require('../models/vendor');
const ComputingModule = require('../models/computingModule');
const AssetIp = require('../models/assetIp');
const AssetCredential = require('../models/assetCredential');
const IpAddress = require('../models/ipAddress');
const appConfig = require('../config/app');
const { requireMaintenance } = require('../middleware/auth');
const AuditLog = require('../models/auditLog');
const EquipmentUsageLog = require('../models/equipmentUsageLog');
const ModuleInventory = require('../models/moduleInventory');
const ModuleInventoryLog = require('../models/moduleInventoryLog');
const ModuleTransferLog = require('../models/moduleTransferLog');
const { getDb } = require('../config/database');
const Photo = require('../models/photo');
const moduleInventoryRouter = require('./moduleInventory');
// Asset list
router.get('/', (req, res) => {
  const filters = {
    asset_type: req.query.asset_type,
    ownership: req.query.ownership,
    status: req.query.status,
    room_id: req.query.room_id,
    search: req.query.search
  };
  const assets = Asset.findAll(filters);
  const rooms = ServerRoom.findAll();
  res.render('assets/index', {
    title: '자산 관리',
    currentPath: '/assets',
    extraCss: null,
    extraJs: null,
    assets,
    rooms,
    filters,
    appConfig
  });
});

// Vendor assets
router.get('/vendor', (req, res) => {
  const assets = Asset.getVendorAssets();
  const vendors = Vendor.findAll();
  // Group by vendor
  const grouped = {};
  assets.forEach(a => {
    const vn = a.vendor_name || '미지정';
    if (!grouped[vn]) grouped[vn] = [];
    grouped[vn].push(a);
  });
  res.render('assets/vendor', {
    title: '업체 장비',
    currentPath: '/assets',
    extraCss: null,
    extraJs: null,
    grouped,
    vendors,
    appConfig
  });
});

// New asset form
router.get('/new', (req, res) => {
  const rooms = ServerRoom.findAll();
  const racks = Rack.findAll();
  const vendors = Vendor.findAll();

  let prefill = null;
  let prefillIps = [];
  if (req.query.from_inventory) {
    const EquipmentUsageLog = require('../models/equipmentUsageLog');
    const invData = EquipmentUsageLog.getLatestByManagement(req.query.from_inventory);
    if (invData) {
      prefill = {
        management_number: invData.management_number || '',
        asset_number: invData.asset_number || '',
        model_name: invData.model_name || '',
        ownership: invData.ownership || 'company'
      };
      // Convert inventory IP columns to prefillIps array
      if (invData.ip1) prefillIps.push({ ip_address: invData.ip1, ip_type: 'management', description: '' });
      if (invData.ip2) prefillIps.push({ ip_address: invData.ip2, ip_type: 'management', description: '' });
      if (invData.ip3) prefillIps.push({ ip_address: invData.ip3, ip_type: 'management', description: '' });
      if (invData.ip4) prefillIps.push({ ip_address: invData.ip4, ip_type: 'management', description: '' });
      if (invData.bmc) prefillIps.push({ ip_address: invData.bmc, ip_type: 'bmc', description: '' });
      if (invData.ib1) prefillIps.push({ ip_address: invData.ib1, ip_type: 'ib', description: '' });
      if (invData.ib2) prefillIps.push({ ip_address: invData.ib2, ip_type: 'ib', description: '' });
    }
  }

  const assets = Asset.findAll();
  res.render('assets/form', {
    title: '자산 등록',
    currentPath: '/assets',
    extraCss: 'rack.css',
    extraJs: null,
    asset: null,
    assetIps: prefillIps,
    assetCredentials: [],
    rooms,
    racks,
    vendors,
    assets,
    prefill: prefill || null,
    linkedRack: null,
    appConfig
  });
});

// Create asset
router.post('/', requireMaintenance, (req, res) => {
  try {
    // Auto-create vendor if new name provided
    if (req.body.vendor_id === '__new__' && req.body.new_vendor_name && req.body.new_vendor_name.trim()) {
      req.body.vendor_id = Vendor.create({ vendor_name: req.body.new_vendor_name.trim() });
    }
    // Auto-create room if new name provided (reuse existing if same name)
    if (req.body.room_id === '__new__' && req.body.new_room_name && req.body.new_room_name.trim()) {
      const roomName = req.body.new_room_name.trim();
      const locType = req.body.loc_type || 'server_room';
      const existingRoom = ServerRoom.findByName(roomName, locType);
      if (existingRoom) {
        req.body.room_id = existingRoom.id;
      } else {
        req.body.room_id = ServerRoom.create({
          name: roomName,
          location_type: locType
        });
      }
    }
    // Auto-create rack if new name provided
    if (req.body.rack_id === '__new__' && req.body.new_rack_name && req.body.new_rack_name.trim() && req.body.room_id) {
      req.body.rack_id = Rack.create({
        room_id: req.body.room_id,
        name: req.body.new_rack_name.trim()
      });
    }
    // Infrastructure types (cdu, immersion_tank, chiller) don't go into racks
    if (['cdu', 'immersion_tank', 'chiller'].includes(req.body.asset_type)) {
      req.body.rack_id = '';
      req.body.rack_unit_start = '';
      req.body.blade_slot = '';
    }

    // Switch slot placement (for immersion tank switch slots)
    const switchSlot = (req.body.switch_slot || '').trim();
    if (switchSlot && switchSlot.match(/^SW\d+$/i)) {
      req.body.blade_slot = switchSlot;
      req.body.rack_unit_start = '';
      req.body.rack_unit_size = '';
    }

    // Validate: rack unit overlap
    const overlap = Asset.checkRackUnitOverlap(req.body.rack_id, req.body.rack_unit_start, req.body.rack_unit_size, req.body.blade_slot);
    if (overlap) throw new Error('랙 위치 충돌: ' + overlap.message);

    const id = Asset.create(req.body);

    // Auto-create linked rack for immersion_tank
    if (req.body.asset_type === 'immersion_tank' && req.body.room_id) {
      const tankCapU = parseInt(req.body.tank_capacity_u) || 10;
      const switchSlots = parseInt(req.body.switch_slots) || 0;
      const tankName = (req.body.model_name || req.body.asset_number || '액침탱크') + ' (탱크)';
      Rack.create({
        room_id: req.body.room_id,
        name: tankName,
        total_units: tankCapU,
        rack_type: 'immersion',
        linked_asset_id: id,
        switch_slots: switchSlots
      });
    }

    // Process multi-IP fields
    const ipAddresses = req.body['ip_addresses[]'] || req.body.ip_addresses || [];
    const ipRealTypes = req.body['ip_real_types[]'] || req.body.ip_real_types || [];
    const ipCustomDescs = req.body['ip_custom_descs[]'] || req.body.ip_custom_descs || [];
    const ipInterfaceTypes = req.body['ip_interface_types[]'] || req.body.ip_interface_types || [];
    const ipSpeedValues = req.body['ip_speed_values[]'] || req.body.ip_speed_values || [];
    const ips = (Array.isArray(ipAddresses) ? ipAddresses : [ipAddresses]).map((addr, i) => ({
      ip_address: addr,
      ip_type: (Array.isArray(ipRealTypes) ? ipRealTypes : [ipRealTypes])[i] || 'management',
      description: (Array.isArray(ipCustomDescs) ? ipCustomDescs : [ipCustomDescs])[i] || '',
      interface_type: (Array.isArray(ipInterfaceTypes) ? ipInterfaceTypes : [ipInterfaceTypes])[i] || '',
      speed: (Array.isArray(ipSpeedValues) ? ipSpeedValues : [ipSpeedValues])[i] || ''
    })).filter(ip => ip.ip_address && ip.ip_address.trim());
    if (ips.length > 0) {
      AssetIp.bulkCreate(id, ips);
    }

    // Sync IPs to ip_addresses table
    const ipAddrsForSync = ips.map(ip => ip.ip_address);
    if (ipAddrsForSync.length > 0) {
      IpAddress.syncAssetIps(id, ipAddrsForSync);
    }

    // Process multi-credential fields
    const credUsernames = req.body['cred_usernames[]'] || req.body.cred_usernames || [];
    const credPasswords = req.body['cred_passwords[]'] || req.body.cred_passwords || [];
    const credTypes = req.body['cred_types[]'] || req.body.cred_types || [];
    const credDescs = req.body['cred_descriptions[]'] || req.body.cred_descriptions || [];
    const creds = (Array.isArray(credUsernames) ? credUsernames : [credUsernames]).map((u, i) => ({
      username: u,
      password: (Array.isArray(credPasswords) ? credPasswords : [credPasswords])[i] || '',
      credential_type: (Array.isArray(credTypes) ? credTypes : [credTypes])[i] || 'root',
      description: (Array.isArray(credDescs) ? credDescs : [credDescs])[i] || ''
    })).filter(c => c.username && c.username.trim());
    if (creds.length > 0) {
      AssetCredential.bulkCreate(id, creds);
    }

    AuditLog.log(req, { action: 'create', targetType: 'asset', targetId: id, targetLabel: req.body.asset_number || req.body.model_name, details: { model_name: req.body.model_name, asset_type: req.body.asset_type } });
    req.flash('success', '자산이 등록되었습니다.');
    res.redirect('/assets/' + id);
  } catch (err) {
    req.flash('error', '자산 등록 실패: ' + err.message);
    res.redirect('/assets/new');
  }
});

// API: available IPs by subnet
router.get('/api/available-ips', (req, res) => {
  try {
    const subnet = req.query.subnet;
    if (!subnet) return res.json({ ips: [] });
    const all = IpAddress.findBySubnet(subnet);
    const available = all.filter(ip => ip.allocation_type === 'available');
    res.json({ ips: available.map(ip => ip.ip_address) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: get racks by room for restore modal
router.get('/api/racks-by-room/:roomId', (req, res) => {
  try {
    const racks = Rack.findByRoom(req.params.roomId);
    res.json(racks.map(r => ({ id: r.id, name: r.name })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Asset detail JSON API
router.get('/:id/json', (req, res) => {
  const asset = Asset.findById(req.params.id);
  if (!asset) return res.status(404).json({ error: 'Not found' });
  const modules = ComputingModule.findByAsset(asset.id);
  const assetIps = AssetIp.findByAsset(asset.id);
  const credentials = AssetCredential.findByAsset(asset.id);
  const parent = asset.parent_asset_id ? Asset.findById(asset.parent_asset_id) : null;
  const children = Asset.findChildren(asset.id);
  res.json({ asset, modules, assetIps, credentials, parent, children });
});

// Asset detail
router.get('/:id', (req, res) => {
  const asset = Asset.findById(req.params.id);
  if (!asset) {
    req.flash('error', '자산을 찾을 수 없습니다.');
    return res.redirect('/assets');
  }
  let modules = ComputingModule.findByAsset(asset.id);
  const assetIps = AssetIp.findByAsset(asset.id);
  const assetCredentials = AssetCredential.findByAsset(asset.id);
  // Get equipment usage logs by management number
  const equipmentLogs = asset.management_number ? EquipmentUsageLog.getHistory(asset.management_number) : [];
  // Get module change logs for this asset
  const moduleChangeLogs = ModuleInventoryLog.findByAsset(asset.id);
  const moduleTransferLogs = ModuleTransferLog.findByAsset(asset.id);

  // Auto-sync: if no computing_modules but latest usage log has hardware_json, create modules
  if (modules.length === 0 && equipmentLogs.length > 0) {
    const latest = equipmentLogs[equipmentLogs.length - 1];
    if (latest.hardware_json) {
      try {
        const hwItems = JSON.parse(latest.hardware_json);
        if (hwItems.length > 0) {
          hwItems.forEach(hw => {
            if (!hw.type || !hw.code) return;
            const ownerVal = hw.ownership || 'company';
            ComputingModule.create({
              asset_id: asset.id,
              module_type: hw.type,
              model: hw.code,
              manufacturer: null,
              capacity: null,
              count: hw.num || 1,
              specification: null,
              slot_info: null,
              notes: hw.role || null,
              owner: ownerVal,
              owner_vendor_id: ownerVal === 'vendor' ? (asset.vendor_id || null) : null
            });
          });
          modules = ComputingModule.findByAsset(asset.id);
        }
      } catch(e) { /* ignore parse errors */ }
    }
  }

  // Enrich modules with item_code from module_inventory (by model name lookup)
  const codePattern = /^(CPU|mem|sto|net|raid|GPU|PSU)-/;
  const allInventory = ModuleInventory.findAll();
  const inventoryByModel = {};
  allInventory.forEach(inv => {
    const key = (inv.model || '').toLowerCase().trim();
    if (key && inv.item_code) inventoryByModel[key] = inv.item_code;
  });
  modules.forEach(m => {
    const spec = m.specification || '';
    if (codePattern.test(spec)) {
      m.item_code = spec;
    } else {
      const key = (m.model || '').toLowerCase().trim();
      m.item_code = inventoryByModel[key] || null;
    }
  });

  // Get rooms for restore modal
  const rooms = ServerRoom.findAll();

  // Get linked rack for immersion_tank
  const linkedRack = (asset.asset_type === 'immersion_tank') ? Rack.findByLinkedAsset(asset.id) : null;
  let linkedRackAssetCount = 0;
  if (linkedRack) {
    const { getDb } = require('../config/database');
    const cnt = getDb().prepare(
      "SELECT COUNT(*) as cnt FROM assets WHERE rack_id = ? AND status NOT IN ('decommissioned')"
    ).get(linkedRack.id);
    linkedRackAssetCount = cnt ? cnt.cnt : 0;
  }

  // Get parent infrastructure asset (for CDU/chiller linked to tank/CDU)
  const parentAsset = asset.parent_asset_id ? Asset.findById(asset.parent_asset_id) : null;

  // Get child infrastructure assets (CDUs/chillers linked to this asset)
  const infraTypes = ['immersion_tank', 'cdu', 'chiller'];
  let childInfraAssets = [];
  if (infraTypes.includes(asset.asset_type)) {
    const { getDb: getDbLocal } = require('../config/database');
    childInfraAssets = getDbLocal().prepare(
      "SELECT id, asset_type, management_number, model_name, status FROM assets WHERE parent_asset_id = ? AND asset_type IN ('cdu','chiller') ORDER BY asset_type, management_number"
    ).all(asset.id);
  }

  const assetPhotos = Photo.findByAssetWithUsageLogs(asset.id, asset.management_number);

  res.render('assets/detail', {
    title: asset.model_name || '자산 상세',
    currentPath: '/assets',
    extraCss: null,
    extraJs: null,
    asset,
    modules,
    assetIps,
    assetCredentials,
    equipmentLogs,
    moduleChangeLogs,
    moduleTransferLogs,
    linkedRack,
    linkedRackAssetCount,
    parentAsset,
    childInfraAssets,
    rooms,
    assetPhotos,
    appConfig
  });
});

// Fault/Repair batch processing
router.post('/:id/fault-repair', requireMaintenance, (req, res) => {
  try {
    const asset = Asset.findById(req.params.id);
    if (!asset) return res.status(404).json({ error: '자산을 찾을 수 없습니다.' });

    const { reason, notes, target_status, modules } = req.body;
    if (!modules || !Array.isArray(modules)) {
      return res.status(400).json({ error: '모듈 정보가 필요합니다.' });
    }

    const db = getDb();
    const assetLabel = asset.management_number || asset.model_name || String(asset.id);
    const userId = req.user ? req.user.id : null;
    const username = req.user ? (req.user.display_name || req.user.username) : null;
    const transferLogs = [];
    const affectedAssetIds = new Set();
    affectedAssetIds.add(asset.id);

    const tx = db.transaction(() => {
      for (const m of modules) {
        if (!m.id || m.action === 'keep') continue;

        const mod = ComputingModule.findById(m.id);
        if (!mod || mod.asset_id !== asset.id) continue;

        const itemCode = mod.specification || null;

        if (m.action === 'storage') {
          // Return to storage: increase storage_quantity (company + vendor)
          if (itemCode) {
            const inv = ModuleInventory.findByCode(itemCode);
            if (inv) {
              const qty = parseInt(mod.count) || 1;
              db.prepare(`
                UPDATE module_inventory
                SET storage_quantity = storage_quantity + ?,
                    updated_at = CURRENT_TIMESTAMP
                WHERE item_code = ?
              `).run(qty, itemCode);

              ModuleInventoryLog.create({
                item_code: itemCode,
                event_type: 'removed',
                quantity_change: qty,
                asset_id: asset.id,
                asset_label: assetLabel,
                user_id: userId,
                username: username,
                notes: (reason || '장애/수리') + ' → 장비실 보관'
              });
            }
          }
          ComputingModule.delete(m.id);
          transferLogs.push({
            module_type: mod.module_type,
            model: mod.model,
            capacity: mod.capacity,
            count: mod.count,
            owner: mod.owner,
            owner_vendor_id: mod.owner_vendor_id,
            from_asset_id: asset.id,
            from_asset_label: assetLabel,
            to_asset_id: null,
            to_asset_label: '장비실',
            reason: reason || '장애/수리',
            user_id: userId,
            username: username,
            notes: notes || null
          });

        } else if (m.action === 'transfer' && m.to_asset_id) {
          // Transfer to another asset
          const toAsset = Asset.findById(m.to_asset_id);
          if (!toAsset) continue;
          const toLabel = toAsset.management_number || toAsset.model_name || String(m.to_asset_id);

          ComputingModule.update(m.id, {
            asset_id: parseInt(m.to_asset_id),
            module_type: mod.module_type,
            model: mod.model,
            manufacturer: mod.manufacturer,
            capacity: mod.capacity,
            count: mod.count,
            specification: mod.specification,
            slot_info: mod.slot_info,
            notes: mod.notes,
            owner: mod.owner,
            owner_vendor_id: mod.owner_vendor_id,
            is_onboard: mod.is_onboard || 0
          });
          affectedAssetIds.add(parseInt(m.to_asset_id));

          transferLogs.push({
            module_type: mod.module_type,
            model: mod.model,
            capacity: mod.capacity,
            count: mod.count,
            owner: mod.owner,
            owner_vendor_id: mod.owner_vendor_id,
            from_asset_id: asset.id,
            from_asset_label: assetLabel,
            to_asset_id: parseInt(m.to_asset_id),
            to_asset_label: toLabel,
            reason: reason || '장애/수리',
            user_id: userId,
            username: username,
            notes: notes || null
          });

          if (itemCode && (!mod.owner || mod.owner === 'company')) {
            ModuleInventoryLog.create({
              item_code: itemCode,
              event_type: 'removed',
              quantity_change: parseInt(mod.count) || 1,
              asset_id: asset.id,
              asset_label: assetLabel,
              user_id: userId,
              username: username,
              notes: '장애이동: ' + assetLabel + ' → ' + toLabel
            });
            ModuleInventoryLog.create({
              item_code: itemCode,
              event_type: 'installed',
              quantity_change: -(parseInt(mod.count) || 1),
              asset_id: parseInt(m.to_asset_id),
              asset_label: toLabel,
              user_id: userId,
              username: username,
              notes: '장애이동: ' + assetLabel + ' → ' + toLabel
            });
          }

        } else if (m.action === 'vendor_send') {
          // Send to vendor: delete module
          ComputingModule.delete(m.id);
          transferLogs.push({
            module_type: mod.module_type,
            model: mod.model,
            capacity: mod.capacity,
            count: mod.count,
            owner: mod.owner,
            owner_vendor_id: mod.owner_vendor_id,
            from_asset_id: asset.id,
            from_asset_label: assetLabel,
            to_asset_id: null,
            to_asset_label: '업체반출',
            reason: reason || '장애/수리',
            user_id: userId,
            username: username,
            notes: notes || null
          });
        }
      }

      // Bulk create transfer logs
      if (transferLogs.length > 0) {
        ModuleTransferLog.bulkCreate(transferLogs);
      }

      // Update asset status
      if (target_status) {
        db.prepare('UPDATE assets SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
          .run(target_status, asset.id);
      }

      // Recalculate inventory and sync usage logs
      ModuleInventory.recalculateInUse();
      for (const aid of affectedAssetIds) {
        moduleInventoryRouter.syncModulesToUsageLog(aid);
      }
    });

    tx();

    AuditLog.log(req, {
      action: 'fault_repair',
      targetType: 'asset',
      targetId: asset.id,
      targetLabel: assetLabel,
      details: { reason, notes, target_status, module_count: modules.length }
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Fault repair error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Individual module action (storage / vendor_return)
router.post('/:id/module-action', requireMaintenance, (req, res) => {
  try {
    const asset = Asset.findById(req.params.id);
    if (!asset) return res.status(404).json({ error: '자산을 찾을 수 없습니다.' });

    const { module_id, action, reason } = req.body;
    if (!module_id || !['storage', 'vendor_return'].includes(action)) {
      return res.status(400).json({ error: '잘못된 요청입니다.' });
    }

    const mod = ComputingModule.findById(module_id);
    if (!mod || mod.asset_id !== asset.id) {
      return res.status(404).json({ error: '모듈을 찾을 수 없습니다.' });
    }

    const db = getDb();
    const assetLabel = asset.management_number || asset.model_name || String(asset.id);
    const userId = req.user ? req.user.id : null;
    const username = req.user ? (req.user.display_name || req.user.username) : null;
    const itemCode = mod.specification || null;
    const qty = parseInt(mod.count) || 1;

    const tx = db.transaction(() => {
      if (action === 'storage') {
        // Return to storage: increase storage_quantity (company + vendor)
        if (itemCode) {
          const inv = ModuleInventory.findByCode(itemCode);
          if (inv) {
            db.prepare(`
              UPDATE module_inventory
              SET storage_quantity = storage_quantity + ?,
                  updated_at = CURRENT_TIMESTAMP
              WHERE item_code = ?
            `).run(qty, itemCode);

            ModuleInventoryLog.create({
              item_code: itemCode,
              event_type: 'removed',
              quantity_change: qty,
              asset_id: asset.id,
              asset_label: assetLabel,
              user_id: userId,
              username: username,
              notes: (reason || '개별처리') + ' → 장비실 보관'
            });
          }
        }

        ComputingModule.delete(module_id);
        ModuleTransferLog.bulkCreate([{
          module_type: mod.module_type,
          model: mod.model,
          capacity: mod.capacity,
          count: mod.count,
          owner: mod.owner,
          owner_vendor_id: mod.owner_vendor_id,
          from_asset_id: asset.id,
          from_asset_label: assetLabel,
          to_asset_id: null,
          to_asset_label: '장비실',
          reason: reason || '장비실 이동',
          user_id: userId,
          username: username,
          notes: null
        }]);

      } else if (action === 'vendor_return') {
        // Vendor return: delete module, log outgoing
        if (itemCode) {
          ModuleInventoryLog.create({
            item_code: itemCode,
            event_type: 'outgoing',
            quantity_change: qty,
            asset_id: asset.id,
            asset_label: assetLabel,
            user_id: userId,
            username: username,
            notes: (reason || '업체 반납') + ' → 업체반출'
          });
        }

        ComputingModule.delete(module_id);
        ModuleTransferLog.bulkCreate([{
          module_type: mod.module_type,
          model: mod.model,
          capacity: mod.capacity,
          count: mod.count,
          owner: mod.owner,
          owner_vendor_id: mod.owner_vendor_id,
          from_asset_id: asset.id,
          from_asset_label: assetLabel,
          to_asset_id: null,
          to_asset_label: '업체반출',
          reason: reason || '업체 반납',
          user_id: userId,
          username: username,
          notes: null
        }]);
      }

      // Recalculate inventory and sync usage logs
      ModuleInventory.recalculateInUse();
      moduleInventoryRouter.syncModulesToUsageLog(asset.id);
    });

    tx();

    AuditLog.log(req, {
      action: 'module_action',
      targetType: 'asset',
      targetId: asset.id,
      targetLabel: assetLabel,
      details: { module_id, action, module_type: mod.module_type, model: mod.model }
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Module action error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Restore from maintenance (수리완료/복귀)
router.post('/:id/restore', requireMaintenance, (req, res) => {
  try {
    const asset = Asset.findById(req.params.id);
    if (!asset) {
      req.flash('error', '자산을 찾을 수 없습니다.');
      return res.redirect('/assets');
    }
    const db = getDb();
    const { room_id, rack_id, rack_unit_start } = req.body;

    let sql = "UPDATE assets SET status = 'active'";
    const params = [];
    if (room_id) {
      sql += ', room_id = ?';
      params.push(room_id);
    }
    if (rack_id) {
      sql += ', rack_id = ?';
      params.push(rack_id);
    }
    if (rack_unit_start) {
      sql += ', rack_unit_start = ?';
      params.push(parseInt(rack_unit_start));
    }
    sql += ', updated_at = CURRENT_TIMESTAMP WHERE id = ?';
    params.push(asset.id);
    db.prepare(sql).run(...params);

    const assetLabel = asset.management_number || asset.model_name || String(asset.id);
    AuditLog.log(req, {
      action: 'restore',
      targetType: 'asset',
      targetId: asset.id,
      targetLabel: assetLabel,
      details: { previous_status: asset.status, room_id, rack_id, rack_unit_start }
    });

    req.flash('success', assetLabel + ' 수리완료 — 운영중으로 복귀했습니다.');
    res.redirect('/assets/' + asset.id);
  } catch (err) {
    req.flash('error', '복귀 처리 중 오류: ' + err.message);
    res.redirect('/assets/' + req.params.id);
  }
});

// Edit asset form
router.get('/:id/edit', (req, res) => {
  const asset = Asset.findById(req.params.id);
  if (!asset) {
    req.flash('error', '자산을 찾을 수 없습니다.');
    return res.redirect('/assets');
  }
  const rooms = ServerRoom.findAll();
  const racks = Rack.findAll();
  const vendors = Vendor.findAll();
  const assetIps = AssetIp.findByAsset(asset.id);
  const assetCredentials = AssetCredential.findByAsset(asset.id);
  const modules = ComputingModule.findByAsset(asset.id);
  const linkedRack = (asset.asset_type === 'immersion_tank') ? Rack.findByLinkedAsset(asset.id) : null;
  const allAssets = Asset.findAll();
  const assetPhotos = Photo.findByAssetWithUsageLogs(asset.id, asset.management_number);
  res.render('assets/form', {
    title: '자산 수정',
    currentPath: '/assets',
    extraCss: 'rack.css',
    extraJs: null,
    asset,
    assetIps,
    assetCredentials,
    modules,
    rooms,
    racks,
    vendors,
    assets: allAssets,
    prefill: null,
    linkedRack,
    assetPhotos,
    appConfig,
    returnTo: req.query.returnTo || req.get('Referer') || ''
  });
});

// Update asset
router.post('/:id', requireMaintenance, (req, res) => {
  const beforeAsset = Asset.findById(req.params.id);
  try {
    // Auto-create vendor if new name provided
    if (req.body.vendor_id === '__new__' && req.body.new_vendor_name && req.body.new_vendor_name.trim()) {
      req.body.vendor_id = Vendor.create({ vendor_name: req.body.new_vendor_name.trim() });
    }
    // Auto-create room if new name provided (reuse existing if same name)
    if (req.body.room_id === '__new__' && req.body.new_room_name && req.body.new_room_name.trim()) {
      const roomName = req.body.new_room_name.trim();
      const locType = req.body.loc_type || 'server_room';
      const existingRoom = ServerRoom.findByName(roomName, locType);
      if (existingRoom) {
        req.body.room_id = existingRoom.id;
      } else {
        req.body.room_id = ServerRoom.create({
          name: roomName,
          location_type: locType
        });
      }
    }
    // Auto-create rack if new name provided
    if (req.body.rack_id === '__new__' && req.body.new_rack_name && req.body.new_rack_name.trim() && req.body.room_id) {
      req.body.rack_id = Rack.create({
        room_id: req.body.room_id,
        name: req.body.new_rack_name.trim()
      });
    }
    // Infrastructure types (cdu, immersion_tank, chiller) don't go into racks
    if (['cdu', 'immersion_tank', 'chiller'].includes(req.body.asset_type)) {
      req.body.rack_id = '';
      req.body.rack_unit_start = '';
      req.body.blade_slot = '';
    }
    // Clear rack info when location type is not server_room
    if (req.body.loc_type && req.body.loc_type !== 'server_room') {
      req.body.rack_id = '';
      req.body.rack_unit_start = '';
      req.body.blade_slot = '';
    }
    // Switch slot placement (for immersion tank switch slots)
    const switchSlotU = (req.body.switch_slot || '').trim();
    if (switchSlotU && switchSlotU.match(/^SW\d+$/i)) {
      req.body.blade_slot = switchSlotU;
      req.body.rack_unit_start = '';
      req.body.rack_unit_size = '';
    }

    // Preserve parent_asset_id if not in form
    if (!req.body.parent_asset_id && beforeAsset.parent_asset_id) {
      req.body.parent_asset_id = beforeAsset.parent_asset_id;
    }

    // Validate: rack unit overlap
    const overlap = Asset.checkRackUnitOverlap(req.body.rack_id, req.body.rack_unit_start, req.body.rack_unit_size, req.body.blade_slot, req.params.id);
    if (overlap) throw new Error('랙 위치 충돌: ' + overlap.message);

    Asset.update(req.params.id, req.body);

    // Sync linked rack for immersion_tank
    if (req.body.asset_type === 'immersion_tank' && req.body.room_id) {
      const tankCapU = parseInt(req.body.tank_capacity_u) || 10;
      const switchSlots = parseInt(req.body.switch_slots) || 0;
      const tankName = (req.body.model_name || req.body.asset_number || '액침탱크') + ' (탱크)';
      const existingRack = Rack.findByLinkedAsset(req.params.id);
      if (existingRack) {
        Rack.update(existingRack.id, {
          room_id: req.body.room_id,
          name: tankName,
          total_units: tankCapU,
          row_position: existingRack.row_position,
          col_position: existingRack.col_position,
          description: existingRack.description,
          rack_type: 'immersion',
          switch_slots: switchSlots
        });
      } else {
        Rack.create({
          room_id: req.body.room_id,
          name: tankName,
          total_units: tankCapU,
          rack_type: 'immersion',
          linked_asset_id: req.params.id,
          switch_slots: switchSlots
        });
      }
    }

    // Re-create IPs: delete then bulk create (only if form contains IP fields)
    const ipAddresses = req.body['ip_addresses[]'] || req.body.ip_addresses || [];
    const ipRealTypes = req.body['ip_real_types[]'] || req.body.ip_real_types || [];
    const ipCustomDescs = req.body['ip_custom_descs[]'] || req.body.ip_custom_descs || [];
    const ipInterfaceTypes = req.body['ip_interface_types[]'] || req.body.ip_interface_types || [];
    const ipSpeedValues = req.body['ip_speed_values[]'] || req.body.ip_speed_values || [];
    const ips = (Array.isArray(ipAddresses) ? ipAddresses : [ipAddresses]).map((addr, i) => ({
      ip_address: addr,
      ip_type: (Array.isArray(ipRealTypes) ? ipRealTypes : [ipRealTypes])[i] || 'management',
      description: (Array.isArray(ipCustomDescs) ? ipCustomDescs : [ipCustomDescs])[i] || '',
      interface_type: (Array.isArray(ipInterfaceTypes) ? ipInterfaceTypes : [ipInterfaceTypes])[i] || '',
      speed: (Array.isArray(ipSpeedValues) ? ipSpeedValues : [ipSpeedValues])[i] || ''
    })).filter(ip => ip.ip_address && ip.ip_address.trim());
    // Only delete+recreate IPs if the form actually submitted IP fields
    // This prevents data loss when a form without IP section is submitted
    const hasIpFieldsInForm = req.body.hasOwnProperty('ip_addresses[]') || req.body.hasOwnProperty('ip_addresses') || req.body.hasOwnProperty('_ip_section_present');
    if (hasIpFieldsInForm) {
      AssetIp.deleteByAsset(req.params.id);
      if (ips.length > 0) {
        AssetIp.bulkCreate(req.params.id, ips);
      }
      // Sync IPs to ip_addresses table
      const ipAddrsForSync = ips.map(ip => ip.ip_address);
      IpAddress.syncAssetIps(req.params.id, ipAddrsForSync);
    } else {
      // Form didn't include IP section — preserve existing IPs
      const existingIps = AssetIp.findByAsset(req.params.id);
      ips.push(...existingIps.map(eip => ({
        ip_address: eip.ip_address,
        ip_type: eip.ip_type || 'management',
        description: eip.description || '',
        interface_type: eip.interface_type || '',
        speed: eip.speed || ''
      })));
    }

    // Re-create credentials: delete then bulk create (only if form contains credential fields)
    const credUsernames = req.body['cred_usernames[]'] || req.body.cred_usernames || [];
    const credPasswords = req.body['cred_passwords[]'] || req.body.cred_passwords || [];
    const credTypes = req.body['cred_types[]'] || req.body.cred_types || [];
    const credDescs = req.body['cred_descriptions[]'] || req.body.cred_descriptions || [];
    const creds = (Array.isArray(credUsernames) ? credUsernames : [credUsernames]).map((u, i) => ({
      username: u,
      password: (Array.isArray(credPasswords) ? credPasswords : [credPasswords])[i] || '',
      credential_type: (Array.isArray(credTypes) ? credTypes : [credTypes])[i] || 'root',
      description: (Array.isArray(credDescs) ? credDescs : [credDescs])[i] || ''
    })).filter(c => c.username && c.username.trim());
    const hasCredFieldsInForm = req.body.hasOwnProperty('cred_usernames[]') || req.body.hasOwnProperty('cred_usernames') || req.body.hasOwnProperty('_cred_section_present');
    if (hasCredFieldsInForm) {
      AssetCredential.deleteByAsset(req.params.id);
      if (creds.length > 0) {
        AssetCredential.bulkCreate(req.params.id, creds);
      }
    }

    const afterAsset = Asset.findById(req.params.id);

    // ===== 입출고 동기화: 관리번호가 있는 자산만 =====
    if (afterAsset.management_number) {
      try {
        const today = new Date().toISOString().split('T')[0];

        // 1) 기존 "사용중" 레코드 → "반납완료" 처리
        EquipmentUsageLog.returnActiveByManagement(afterAsset.management_number, today);

        // 2) IP 매핑 (ips → ip1~ip4, bmc, ib1~ib2)
        let ip1 = null, ip2 = null, ip3 = null, ip4 = null, bmc = null, ib1 = null, ib2 = null;
        const generalIps = [];
        const ibIps = [];
        ips.forEach(ip => {
          if (ip.ip_type === 'bmc') {
            bmc = ip.ip_address;
          } else if (ip.ip_type === 'ib') {
            ibIps.push(ip.ip_address);
          } else {
            generalIps.push(ip.ip_address);
          }
        });
        if (generalIps[0]) ip1 = generalIps[0];
        if (generalIps[1]) ip2 = generalIps[1];
        if (generalIps[2]) ip3 = generalIps[2];
        if (generalIps[3]) ip4 = generalIps[3];
        if (ibIps[0]) ib1 = ibIps[0];
        if (ibIps[1]) ib2 = ibIps[1];

        // 3) Credential 매핑 (creds → credentials_json + legacy columns)
        let credential_root = null, credential_etc1 = null, credential_etc2 = null;
        const etcCreds = [];
        const credJsonItems = [];
        creds.forEach(c => {
          const pair = c.username + ' / ' + c.password;
          credJsonItems.push({ type: c.credential_type || 'etc', username: c.username || '', password: c.password || '' });
          if (c.credential_type === 'root') {
            credential_root = pair;
          } else {
            etcCreds.push(pair);
          }
        });
        if (etcCreds[0]) credential_etc1 = etcCreds[0];
        if (etcCreds[1]) credential_etc2 = etcCreds[1];
        const credentials_json = credJsonItems.length > 0 ? JSON.stringify(credJsonItems) : null;

        // 4) Unit 계산 (rack_unit_start → U표기)
        let unit = null;
        const slot = parseInt(afterAsset.rack_unit_start);
        const size = parseInt(afterAsset.rack_unit_size) || 3;
        if (slot) {
          const uStart = Math.floor((slot - 1) / 3) + 1;
          const uEnd = Math.floor((slot + size - 2) / 3) + 1;
          unit = uStart === uEnd ? 'U' + uStart : 'U' + uStart + '-U' + uEnd;
        }

        // 5) ips_json 생성
        const ipsJsonItems = [];
        ips.forEach(ip => {
          if (ip.ip_address && ip.ip_address.trim()) {
            ipsJsonItems.push({ purpose: ip.ip_type || 'management', ip: ip.ip_address });
          }
        });
        const ips_json = ipsJsonItems.length > 0 ? JSON.stringify(ipsJsonItems) : null;

        // 6) �� "사용중" 레코드 생성
        EquipmentUsageLog.create({
          usage_date: today,
          asset_number: afterAsset.asset_number || null,
          management_number: afterAsset.management_number,
          model_name: afterAsset.model_name || null,
          ownership: afterAsset.ownership || 'company',
          credential_root: credential_root,
          credential_etc1: credential_etc1,
          credential_etc2: credential_etc2,
          credentials_json: credentials_json,
          ip1: ip1, ip2: ip2, ip3: ip3, ip4: ip4,
          bmc: bmc, ib1: ib1, ib2: ib2,
          ips_json: ips_json,
          room: afterAsset.room_name || null,
          rack: afterAsset.rack_name || null,
          unit: unit,
          status: '사용중'
        });

        // 7) 컴���팅 모듈 → 입출고 하드웨어 컬럼 동기화
        moduleInventoryRouter.syncModulesToUsageLog(req.params.id);
      } catch (syncErr) {
        console.error('입출고 동기화 오류:', syncErr);
      }
    }
    // ===== 입출고 동기화 끝 =====

    AuditLog.log(req, { action: 'update', targetType: 'asset', targetId: req.params.id, targetLabel: req.body.asset_number || req.body.model_name, details: { before: beforeAsset, after: afterAsset } });
    req.flash('success', '자산이 수정되었습니다.');
    const returnTo = Array.isArray(req.body.returnTo) ? req.body.returnTo[0] : req.body.returnTo;
    res.redirect(returnTo || '/assets/' + req.params.id);
  } catch (err) {
    console.error('자산 수정 오류:', err.message);
    req.flash('error', '자산 수정 실패: ' + err.message);
    res.redirect('/assets/' + req.params.id + '/edit');
  }
});

// Delete asset
router.post('/:id/delete', requireMaintenance, (req, res) => {
  const asset = Asset.findById(req.params.id);
  const returnTo = req.body.returnTo || req.get('Referer') || '/assets';
  try {
    // Block deletion of immersion_tank if linked rack has assets inside
    if (asset && asset.asset_type === 'immersion_tank') {
      const linkedRack = Rack.findByLinkedAsset(asset.id);
      if (linkedRack) {
        const { getDb } = require('../config/database');
        const rackAssetCount = getDb().prepare(
          "SELECT COUNT(*) as cnt FROM assets WHERE rack_id = ? AND status NOT IN ('decommissioned')"
        ).get(linkedRack.id);
        if (rackAssetCount && rackAssetCount.cnt > 0) {
          throw new Error('탱크 내부에 장비 ' + rackAssetCount.cnt + '대가 배치되어 있어 삭제할 수 없습니다. 먼저 장비를 제거해주세요.');
        }
        // Delete linked rack if empty
        Rack.delete(linkedRack.id);
      }
    }
    Photo.deleteByEntity('asset', parseInt(req.params.id));
    Asset.delete(req.params.id);
    AuditLog.log(req, { action: 'delete', targetType: 'asset', targetId: req.params.id, targetLabel: asset ? (asset.asset_number || asset.model_name) : req.params.id });
    req.flash('success', '자산이 삭제되었습니다.');
    res.redirect(returnTo);
  } catch (err) {
    req.flash('error', '삭제 실패: ' + err.message);
    res.redirect('/assets/' + req.params.id);
  }
});

module.exports = router;
