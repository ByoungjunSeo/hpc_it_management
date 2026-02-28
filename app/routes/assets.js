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
    vendors
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

  res.render('assets/form', {
    title: '자산 등록',
    currentPath: '/assets',
    extraCss: null,
    extraJs: null,
    asset: null,
    assetIps: prefillIps,
    assetCredentials: [],
    rooms,
    racks,
    vendors,
    prefill: prefill || null,
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
    // Validate: rack unit overlap
    const overlap = Asset.checkRackUnitOverlap(req.body.rack_id, req.body.rack_unit_start, req.body.rack_unit_size, req.body.blade_slot);
    if (overlap) throw new Error('랙 위치 충돌: ' + overlap.message);

    const id = Asset.create(req.body);

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

// Asset detail JSON API
router.get('/:id/json', (req, res) => {
  const asset = Asset.findById(req.params.id);
  if (!asset) return res.status(404).json({ error: 'Not found' });
  const modules = ComputingModule.findByAsset(asset.id);
  const assetIps = AssetIp.findByAsset(asset.id);
  const credentials = AssetCredential.findByAsset(asset.id);
  res.json({ asset, modules, assetIps, credentials });
});

// Asset detail
router.get('/:id', (req, res) => {
  const asset = Asset.findById(req.params.id);
  if (!asset) {
    req.flash('error', '자산을 찾을 수 없습니다.');
    return res.redirect('/assets');
  }
  const modules = ComputingModule.findByAsset(asset.id);
  const assetIps = AssetIp.findByAsset(asset.id);
  const assetCredentials = AssetCredential.findByAsset(asset.id);
  // Get equipment usage logs by management number
  const EquipmentUsageLog = require('../models/equipmentUsageLog');
  const equipmentLogs = asset.management_number ? EquipmentUsageLog.getHistory(asset.management_number) : [];
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
    appConfig
  });
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
  res.render('assets/form', {
    title: '자산 수정',
    currentPath: '/assets',
    extraCss: null,
    extraJs: null,
    asset,
    assetIps,
    assetCredentials,
    rooms,
    racks,
    vendors,
    prefill: null,
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
    // Clear rack info when location type is not server_room
    if (req.body.loc_type && req.body.loc_type !== 'server_room') {
      req.body.rack_id = '';
      req.body.rack_unit_start = '';
      req.body.blade_slot = '';
    }
    // Validate: rack unit overlap
    const overlap = Asset.checkRackUnitOverlap(req.body.rack_id, req.body.rack_unit_start, req.body.rack_unit_size, req.body.blade_slot, req.params.id);
    if (overlap) throw new Error('랙 위치 충돌: ' + overlap.message);

    Asset.update(req.params.id, req.body);

    // Re-create IPs: delete then bulk create
    AssetIp.deleteByAsset(req.params.id);
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
      AssetIp.bulkCreate(req.params.id, ips);
    }

    // Sync IPs to ip_addresses table
    const ipAddrsForSync = ips.map(ip => ip.ip_address);
    IpAddress.syncAssetIps(req.params.id, ipAddrsForSync);

    // Re-create credentials: delete then bulk create
    AssetCredential.deleteByAsset(req.params.id);
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
      AssetCredential.bulkCreate(req.params.id, creds);
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

        // 6) 새 "사용중" 레코드 생성
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
      } catch (syncErr) {
        console.error('입출고 동기화 오류:', syncErr);
      }
    }
    // ===== 입출고 동기화 끝 =====

    AuditLog.log(req, { action: 'update', targetType: 'asset', targetId: req.params.id, targetLabel: req.body.asset_number || req.body.model_name, details: { before: beforeAsset, after: afterAsset } });
    req.flash('success', '자산이 수정되었습니다.');
    const returnTo = req.body.returnTo;
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
