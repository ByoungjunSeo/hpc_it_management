const express = require('express');
const router = express.Router();
const Asset = require('../models/asset');
const Rack = require('../models/rack');
const ServerRoom = require('../models/serverRoom');
const Vendor = require('../models/vendor');
const AssetIp = require('../models/assetIp');
const AssetCredential = require('../models/assetCredential');
const IpAddress = require('../models/ipAddress');
const appConfig = require('../config/app');
const { requireMaintenance } = require('../middleware/auth');
const AuditLog = require('../models/auditLog');
const ComputingModule = require('../models/computingModule');
const Photo = require('../models/photo');
const { pool } = require('../config/database');

// Asset list
router.get('/', async (req, res) => {
  try {
    const filters = {
      asset_type: req.query.asset_type,
      ownership: req.query.ownership,
      status: req.query.status,
      room_id: req.query.room_id,
      search: req.query.search
    };
    const assets = await Asset.findAll(filters);
    const rooms = await ServerRoom.findAll();
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
  } catch (err) {
    req.flash('error', '자산 목록 조회 실패: ' + err.message);
    res.redirect('/');
  }
});

// Vendor assets
router.get('/vendor', async (req, res) => {
  try {
    const assets = await Asset.getVendorAssets();
    const vendors = await Vendor.findAll();
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
  } catch (err) {
    req.flash('error', '업체 장비 조회 실패: ' + err.message);
    res.redirect('/assets');
  }
});

// New asset form
router.get('/new', async (req, res) => {
  try {
    const rooms = await ServerRoom.findAll();
    const racks = await Rack.findAll();
    const vendors = await Vendor.findAll();

    let prefill = null;
    let prefillIps = [];
    // EUL prefill — v2 EUL has JSONB snapshots, not ip1~ip4 columns.
    // Prefill from EUL deferred to B-4d-6 (EUL event-sourcing mapping).
    // from_inventory param is accepted but no prefill data extracted.

    const assets = await Asset.findAll();
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
  } catch (err) {
    req.flash('error', '자산 등록 폼 로드 실패: ' + err.message);
    res.redirect('/assets');
  }
});

// Create asset
router.post('/', requireMaintenance, async (req, res) => {
  try {
    // Auto-create vendor if new name provided
    if (req.body.vendor_id === '__new__' && req.body.new_vendor_name && req.body.new_vendor_name.trim()) {
      req.body.vendor_id = await Vendor.create({ vendor_name: req.body.new_vendor_name.trim() });
    }
    // Auto-create room if new name provided (reuse existing if same name)
    if (req.body.room_id === '__new__' && req.body.new_room_name && req.body.new_room_name.trim()) {
      const roomName = req.body.new_room_name.trim();
      const locType = req.body.loc_type || 'server_room';
      const existingRoom = await ServerRoom.findByName(roomName, locType);
      if (existingRoom) {
        req.body.room_id = existingRoom.id;
      } else {
        req.body.room_id = await ServerRoom.create({
          name: roomName,
          location_type: locType
        });
      }
    }
    // Auto-create rack if new name provided
    if (req.body.rack_id === '__new__' && req.body.new_rack_name && req.body.new_rack_name.trim() && req.body.room_id) {
      req.body.rack_id = await Rack.create({
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
    const overlap = await Asset.checkRackUnitOverlap(req.body.rack_id, req.body.rack_unit_start, req.body.rack_unit_size, req.body.blade_slot);
    if (overlap) throw new Error('랙 위치 충돌: ' + overlap.message);

    const id = await Asset.create(req.body);

    // Auto-create linked rack for immersion_tank
    if (req.body.asset_type === 'immersion_tank' && req.body.room_id) {
      const tankCapU = parseInt(req.body.tank_capacity_u) || 10;
      const switchSlots = parseInt(req.body.switch_slots) || 0;
      const tankName = (req.body.model_name || req.body.asset_number || '액침탱크') + ' (탱크)';
      await Rack.create({
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
      await AssetIp.bulkCreate(id, ips);
    }

    // Sync IPs to ip_addresses table
    const ipAddrsForSync = ips.map(ip => ip.ip_address);
    if (ipAddrsForSync.length > 0) {
      await IpAddress.syncAssetIps(id, ipAddrsForSync);
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
      await AssetCredential.bulkCreate(id, creds);
    }

    // BUG-4: v1 passes object without stringify — faithful porting (do NOT add stringify)
    AuditLog.log(req, { action: 'create', targetType: 'asset', targetId: id, targetLabel: req.body.asset_number || req.body.model_name, details: { model_name: req.body.model_name, asset_type: req.body.asset_type } });
    req.flash('success', '자산이 등록되었습니다.');
    res.redirect('/assets/' + id);
  } catch (err) {
    req.flash('error', '자산 등록 실패: ' + err.message);
    res.redirect('/assets/new');
  }
});

// API: available IPs by subnet
router.get('/api/available-ips', async (req, res) => {
  try {
    const subnet = req.query.subnet;
    if (!subnet) return res.json({ ips: [] });
    const all = await IpAddress.findBySubnet(subnet);
    const available = all.filter(ip => ip.allocation_type === 'available');
    res.json({ ips: available.map(ip => ip.ip_address) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: get racks by room for restore modal
router.get('/api/racks-by-room/:roomId', async (req, res) => {
  try {
    const racks = await Rack.findByRoom(req.params.roomId);
    res.json(racks.map(r => ({ id: r.id, name: r.name })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Asset detail JSON API
router.get('/:id/json', async (req, res) => {
  try {
    const asset = await Asset.findById(req.params.id);
    if (!asset) return res.status(404).json({ error: 'Not found' });
    const modules = await ComputingModule.findByAsset(asset.id);
    const assetIps = await AssetIp.findByAsset(asset.id);
    const credentials = await AssetCredential.findByAsset(asset.id);
    const parent = asset.parent_asset_id ? await Asset.findById(asset.parent_asset_id) : null;
    const children = await Asset.findChildren(asset.id);
    res.json({ asset, modules, assetIps, credentials, parent, children });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Asset detail
router.get('/:id', async (req, res) => {
  try {
    const asset = await Asset.findById(req.params.id);
    if (!asset) {
      req.flash('error', '자산을 찾을 수 없습니다.');
      return res.redirect('/assets');
    }
    let modules = await ComputingModule.findByAsset(asset.id);
    const assetIps = await AssetIp.findByAsset(asset.id);
    const assetCredentials = await AssetCredential.findByAsset(asset.id);
    // EUL history — deferred to B-4d-6 (v2 EUL has different column structure)
    const equipmentLogs = [];
    // Module change/transfer logs — deferred to B-4d-3/4
    const moduleChangeLogs = [];
    const moduleTransferLogs = [];

    // Auto-sync: skipped — depends on EUL + ComputingModule.create (B-4d-3/4 scope)
    // Module enrichment with item_code: skipped — depends on ModuleInventory (B-4d-3/4 scope)

    // Get rooms for restore modal
    const rooms = await ServerRoom.findAll();

    // Get linked rack for immersion_tank
    const linkedRack = (asset.asset_type === 'immersion_tank') ? await Rack.findByLinkedAsset(asset.id) : null;
    let linkedRackAssetCount = 0;
    if (linkedRack) {
      const { rows: [cnt] } = await pool.query(
        "SELECT COUNT(*) as cnt FROM assets WHERE rack_id = $1 AND status NOT IN ('decommissioned')",
        [linkedRack.id]
      );
      linkedRackAssetCount = cnt ? parseInt(cnt.cnt) : 0;
    }

    // Get parent infrastructure asset
    const parentAsset = asset.parent_asset_id ? await Asset.findById(asset.parent_asset_id) : null;

    // Get child infrastructure assets
    const infraTypes = ['immersion_tank', 'cdu', 'chiller'];
    let childInfraAssets = [];
    if (infraTypes.includes(asset.asset_type)) {
      const { rows } = await pool.query(
        "SELECT id, asset_type, management_number, model_name, status FROM assets WHERE parent_asset_id = $1 AND asset_type IN ('cdu','chiller') ORDER BY asset_type, management_number",
        [asset.id]
      );
      childInfraAssets = rows;
    }

    const assetPhotos = await Photo.findByAssetWithUsageLogs(asset.id, asset.management_number);

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
  } catch (err) {
    req.flash('error', '자산 상세 조회 실패: ' + err.message);
    res.redirect('/assets');
  }
});

// Fault/Repair batch processing — stub (depends on ComputingModule/ModuleInventory/TransferLog: B-4d-3/4)
router.post('/:id/fault-repair', requireMaintenance, async (req, res) => {
  res.status(503).json({ error: '장애/수리 처리는 B-4d-3/4에서 구현 예정입니다.' });
});

// Individual module action — stub (depends on ComputingModule/ModuleInventory/TransferLog: B-4d-3/4)
router.post('/:id/module-action', requireMaintenance, async (req, res) => {
  res.status(503).json({ error: '모듈 개별 처리는 B-4d-3/4에서 구현 예정입니다.' });
});

// Restore from maintenance (수리완료/복귀)
router.post('/:id/restore', requireMaintenance, async (req, res) => {
  try {
    const asset = await Asset.findById(req.params.id);
    if (!asset) {
      req.flash('error', '자산을 찾을 수 없습니다.');
      return res.redirect('/assets');
    }
    const { room_id, rack_id, rack_unit_start } = req.body;

    let sql = "UPDATE assets SET status = 'active'";
    const params = [];
    let idx = 1;
    if (room_id) {
      sql += ', room_id = $' + idx++;
      params.push(room_id);
    }
    if (rack_id) {
      sql += ', rack_id = $' + idx++;
      params.push(rack_id);
    }
    if (rack_unit_start) {
      sql += ', rack_unit_start = $' + idx++;
      params.push(parseInt(rack_unit_start));
    }
    sql += ', updated_at = CURRENT_TIMESTAMP WHERE id = $' + idx;
    params.push(asset.id);
    await pool.query(sql, params);

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
router.get('/:id/edit', async (req, res) => {
  try {
    const asset = await Asset.findById(req.params.id);
    if (!asset) {
      req.flash('error', '자산을 찾을 수 없습니다.');
      return res.redirect('/assets');
    }
    const rooms = await ServerRoom.findAll();
    const racks = await Rack.findAll();
    const vendors = await Vendor.findAll();
    const assetIps = await AssetIp.findByAsset(asset.id);
    const assetCredentials = await AssetCredential.findByAsset(asset.id);
    const modules = await ComputingModule.findByAsset(asset.id);
    const linkedRack = (asset.asset_type === 'immersion_tank') ? await Rack.findByLinkedAsset(asset.id) : null;
    const allAssets = await Asset.findAll();
    const assetPhotos = await Photo.findByAssetWithUsageLogs(asset.id, asset.management_number);
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
  } catch (err) {
    req.flash('error', '자산 수정 폼 로드 실패: ' + err.message);
    res.redirect('/assets');
  }
});

// Update asset
router.post('/:id', requireMaintenance, async (req, res) => {
  const beforeAsset = await Asset.findById(req.params.id);
  try {
    // Auto-create vendor if new name provided
    if (req.body.vendor_id === '__new__' && req.body.new_vendor_name && req.body.new_vendor_name.trim()) {
      req.body.vendor_id = await Vendor.create({ vendor_name: req.body.new_vendor_name.trim() });
    }
    // Auto-create room if new name provided (reuse existing if same name)
    if (req.body.room_id === '__new__' && req.body.new_room_name && req.body.new_room_name.trim()) {
      const roomName = req.body.new_room_name.trim();
      const locType = req.body.loc_type || 'server_room';
      const existingRoom = await ServerRoom.findByName(roomName, locType);
      if (existingRoom) {
        req.body.room_id = existingRoom.id;
      } else {
        req.body.room_id = await ServerRoom.create({
          name: roomName,
          location_type: locType
        });
      }
    }
    // Auto-create rack if new name provided
    if (req.body.rack_id === '__new__' && req.body.new_rack_name && req.body.new_rack_name.trim() && req.body.room_id) {
      req.body.rack_id = await Rack.create({
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
    // BUG-5: Switch slot placement — v1 faithful (blade_slot clearing logic as-is)
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
    const overlap = await Asset.checkRackUnitOverlap(req.body.rack_id, req.body.rack_unit_start, req.body.rack_unit_size, req.body.blade_slot, req.params.id);
    if (overlap) throw new Error('랙 위치 충돌: ' + overlap.message);

    await Asset.update(req.params.id, req.body);

    // Sync linked rack for immersion_tank
    if (req.body.asset_type === 'immersion_tank' && req.body.room_id) {
      const tankCapU = parseInt(req.body.tank_capacity_u) || 10;
      const switchSlots = parseInt(req.body.switch_slots) || 0;
      const tankName = (req.body.model_name || req.body.asset_number || '액침탱크') + ' (탱크)';
      const existingRack = await Rack.findByLinkedAsset(req.params.id);
      if (existingRack) {
        await Rack.update(existingRack.id, {
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
        await Rack.create({
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
    const hasIpFieldsInForm = req.body.hasOwnProperty('ip_addresses[]') || req.body.hasOwnProperty('ip_addresses') || req.body.hasOwnProperty('_ip_section_present');
    if (hasIpFieldsInForm) {
      await AssetIp.deleteByAsset(req.params.id);
      if (ips.length > 0) {
        await AssetIp.bulkCreate(req.params.id, ips);
      }
      // Sync IPs to ip_addresses table
      const ipAddrsForSync = ips.map(ip => ip.ip_address);
      await IpAddress.syncAssetIps(req.params.id, ipAddrsForSync);
    } else {
      // Form didn't include IP section — preserve existing IPs
      const existingIps = await AssetIp.findByAsset(req.params.id);
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
      await AssetCredential.deleteByAsset(req.params.id);
      if (creds.length > 0) {
        await AssetCredential.bulkCreate(req.params.id, creds);
      }
    }

    const afterAsset = await Asset.findById(req.params.id);

    // ===== 입출고 동기화 — v2 EUL JSONB 구조 불일치로 스텁 처리 =====
    // v1은 ip1~ip4, bmc, ib1~ib2, credential_root 등 50+개 컬럼 직접 기록.
    // v2 EUL은 event_type + JSONB 스냅샷(network_snapshot, credentials_snapshot 등).
    // EUL 동기화는 B-4d-6 (이벤트소싱 매핑)에서 구현.
    // ===== 입출고 동기화 끝 =====

    // BUG-4: v1 passes objects (before/after) without stringify — faithful porting
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
router.post('/:id/delete', requireMaintenance, async (req, res) => {
  const asset = await Asset.findById(req.params.id);
  const returnTo = req.body.returnTo || req.get('Referer') || '/assets';
  try {
    // Block deletion of immersion_tank if linked rack has assets inside
    if (asset && asset.asset_type === 'immersion_tank') {
      const linkedRack = await Rack.findByLinkedAsset(asset.id);
      if (linkedRack) {
        const { rows: [rackAssetCount] } = await pool.query(
          "SELECT COUNT(*) as cnt FROM assets WHERE rack_id = $1 AND status NOT IN ('decommissioned')",
          [linkedRack.id]
        );
        if (rackAssetCount && parseInt(rackAssetCount.cnt) > 0) {
          throw new Error('탱크 내부에 장비 ' + rackAssetCount.cnt + '대가 배치되어 있어 삭제할 수 없습니다. 먼저 장비를 제거해주세요.');
        }
        // Delete linked rack if empty
        await Rack.delete(linkedRack.id);
      }
    }
    await Photo.deleteByEntity('asset', parseInt(req.params.id));
    await Asset.delete(req.params.id);
    AuditLog.log(req, { action: 'delete', targetType: 'asset', targetId: req.params.id, targetLabel: asset ? (asset.asset_number || asset.model_name) : req.params.id });
    req.flash('success', '자산이 삭제되었습니다.');
    res.redirect(returnTo);
  } catch (err) {
    req.flash('error', '삭제 실패: ' + err.message);
    res.redirect('/assets/' + req.params.id);
  }
});

module.exports = router;
