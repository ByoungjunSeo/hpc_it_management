const express = require('express');
const router = express.Router();
const Asset = require('../models/asset');
const Rack = require('../models/rack');
const ServerRoom = require('../models/serverRoom');
const Vendor = require('../models/vendor');
const AssetIp = require('../models/assetIp');
const AssetCredential = require('../models/assetCredential');
const IpAddress = require('../models/ipAddress');
const Subnet = require('../models/subnet');
const appConfig = require('../config/app');
const { requireMaintenance, requireAdmin } = require('../middleware/auth');
const sshTerminal = require('../services/sshTerminal');
const AuditLog = require('../models/auditLog');
const ComputingModule = require('../models/computingModule');
const ModuleInventory = require('../models/moduleInventory');
const ModuleInventoryLog = require('../models/moduleInventoryLog');
const ModuleTransferLog = require('../models/moduleTransferLog');
const moduleInventoryRouter = require('./moduleInventory');
const Photo = require('../models/photo');
const Lending = require('../models/lending');
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
    if (req.query.from_inventory) {
      // B-4d-10 §5: 현재상태 유일 소스인 assets(+asset_ips)를 1순위로 prefill.
      // 자산 미등록/삭제(mgmt가 EUL에만 있는 경우)는 EUL 최신 이벤트로 복원 —
      // 6a flatten이 ip1~ib2 가상컬럼을 제공하므로 v1 계약 그대로 유지.
      const mgmt = req.query.from_inventory;
      const existing = await Asset.findByManagementNumber(mgmt);
      if (existing) {
        prefill = {
          management_number: existing.management_number || '',
          asset_number: existing.asset_number || '',
          model_name: existing.model_name || '',
          ownership: existing.ownership || 'company'
        };
        prefillIps = (await AssetIp.findByAsset(existing.id)).map(ip => ({
          ip_address: ip.ip_address,
          ip_type: ip.ip_type || 'management',
          description: ip.description || ''
        }));
      } else {
        const EquipmentUsageLog = require('../models/equipmentUsageLog');
        const invData = await EquipmentUsageLog.getLatestByManagement(mgmt);
        if (invData) {
          prefill = {
            management_number: invData.management_number || '',
            asset_number: invData.asset_number || '',
            model_name: invData.model_name || '',
            ownership: invData.ownership || 'company'
          };
          // flatten 가상컬럼(ip1~ip4/bmc/ib1/ib2) → prefillIps (v1 L85–91 계약)
          if (invData.ip1) prefillIps.push({ ip_address: invData.ip1, ip_type: 'management', description: '' });
          if (invData.ip2) prefillIps.push({ ip_address: invData.ip2, ip_type: 'management', description: '' });
          if (invData.ip3) prefillIps.push({ ip_address: invData.ip3, ip_type: 'management', description: '' });
          if (invData.ip4) prefillIps.push({ ip_address: invData.ip4, ip_type: 'management', description: '' });
          if (invData.bmc) prefillIps.push({ ip_address: invData.bmc, ip_type: 'bmc', description: '' });
          if (invData.ib1) prefillIps.push({ ip_address: invData.ib1, ip_type: 'ib', description: '' });
          if (invData.ib2) prefillIps.push({ ip_address: invData.ib2, ip_type: 'ib', description: '' });
        }
      }
    }

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
      const existingRoom = await ServerRoom.findByNameNormalized(roomName, locType); // BL-3: 정규화 비교
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
    // B-6e Part4: 풀 기반 available (대량 대역 대비 LIMIT 512)
    const ips = await IpAddress.findAvailable(subnet, 512);
    res.json({ ips, limited: ips.length >= 512 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: 등록된 서브넷 목록 (가용 IP 조회 모달 select용) — B-6e subnets 테이블 기반
router.get('/api/subnets', async (req, res) => {
  try {
    const rows = await Subnet.findAllWithStats();
    res.json({ subnets: rows.map(s => ({
      cidr: s.cidr, name: s.name, available: Number(s.available) || 0
    })) });
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
    const credentials = await AssetCredential.findByAssetMasked(asset.id);
    const parent = asset.parent_asset_id ? await Asset.findById(asset.parent_asset_id) : null;
    const children = await Asset.findChildren(asset.id);
    // BL-11 후속: 응답에 자격증명 평문 미포함. 레거시 asset.ssh_password도 제거([보기] API로만).
    if (asset && 'ssh_password' in asset) { asset.ssh_password = undefined; }
    res.json({ asset, modules, assetIps, credentials, parent, children });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// BL-11 후속: [보기] 전용 — 단일 자격증명 복호화 값 반환 + 조회 이력 기록.
// 권한은 기존 화면과 동일(requireLogin 전역). 값은 audit에 미기록.
router.get('/:id/credential/:credId/reveal', async (req, res) => {
  try {
    const asset = await Asset.findById(req.params.id);
    if (!asset) return res.status(404).json({ error: 'Not found' });
    const password = await AssetCredential.revealPassword(req.params.credId, req.params.id);
    if (password === null || password === undefined) return res.status(404).json({ error: '자격증명을 찾을 수 없습니다.' });
    await AuditLog.log(req, {
      action: 'credential_reveal', targetType: 'asset', targetId: parseInt(req.params.id, 10),
      targetLabel: asset.management_number || asset.asset_number,
      details: { credential_id: parseInt(req.params.credId, 10) }
    });
    res.json({ password });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// T2: 웹 SSH 터미널 페이지 (관리자 한정). 비밀번호 값은 뷰에 일절 내리지 않는다.
router.get('/:id/terminal', requireAdmin, async (req, res) => {
  try {
    const asset = await Asset.findById(req.params.id);
    if (!asset) { req.flash('error', '자산을 찾을 수 없습니다.'); return res.redirect('/assets'); }
    const ips = await AssetIp.findByAsset(asset.id);
    const creds = await AssetCredential.findByAssetMasked(asset.id); // 값 없음(id/username/type/has_password)
    // 수동 선택 목록: BMC/IPMI만 숨기고 그 외(root/os/user/etc)는 허용. 값 있는 것만.
    const sshCreds = creds.filter(c => !sshTerminal.SSH_EXCLUDED_TYPES.includes(c.credential_type) && c.has_password);
    const target = sshTerminal.resolveTarget(asset, ips); // { ip, port } — 비밀번호 무관
    res.render('assets/terminal', {
      title: 'SSH 터미널 - ' + (asset.management_number || asset.model_name || asset.id),
      currentPath: '/assets', extraCss: null, extraJs: null,
      asset, prefillIp: target.ip || '', prefillPort: target.port || 22,
      sshCreds, // 선택 목록(복수일 때) — username/type/id만
    });
  } catch (err) {
    req.flash('error', 'SSH 터미널 로드 실패: ' + err.message);
    res.redirect('/assets/' + req.params.id);
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
    const assetCredentials = await AssetCredential.findByAssetMasked(asset.id);
    // EUL history — deferred to B-4d-6 (v2 EUL has different column structure)
    const equipmentLogs = [];
    // Module change/transfer logs — deferred to B-4d-3/4
    const moduleChangeLogs = [];
    const moduleTransferLogs = [];

    // Auto-sync: skipped — depends on EUL + ComputingModule.create (B-4d-3/4 scope)
    // Module enrichment with item_code: skipped — depends on ModuleInventory (B-4d-3/4 scope)

    // BL-13: 이 자산이 잔여 수량으로 걸린 active 대여 건 — 상세 배지 표시용
    const activeLendings = await Lending.findActiveByAsset(asset.id);

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
      activeLendings,
      appConfig
    });
  } catch (err) {
    req.flash('error', '자산 상세 조회 실패: ' + err.message);
    res.redirect('/assets');
  }
});

// Fault/Repair batch processing (B-4d-8b, v1 L376–563 이식)
// 트랜잭션 경계: v1은 better-sqlite3 transaction — v2 모델들이 pool 개별 연결이라 단일 트랜잭션
// 불가, 순차 실행으로 이식(v2 lendings 트랜잭션 2종과 동일 관례). 원자성 강화는 개선 트랙.
router.post('/:id/fault-repair', requireMaintenance, async (req, res) => {
  try {
    const asset = await Asset.findById(req.params.id);
    if (!asset) return res.status(404).json({ error: '자산을 찾을 수 없습니다.' });

    const { reason, notes, target_status, modules } = req.body;
    if (!modules || !Array.isArray(modules)) {
      return res.status(400).json({ error: '모듈 정보가 필요합니다.' });
    }

    const assetLabel = asset.management_number || asset.model_name || String(asset.id);
    const userId = req.session.userId || null;
    const username = req.session.displayName || req.session.username || null;
    const transferLogs = [];
    const affectedAssetIds = new Set();
    affectedAssetIds.add(asset.id);

    for (const m of modules) {
      if (!m.id || m.action === 'keep') continue;

      const mod = await ComputingModule.findById(m.id);
      if (!mod || mod.asset_id !== asset.id) continue;

      const itemCode = mod.specification || null;

      if (m.action === 'storage') {
        // Return to storage: increase storage_quantity (company + vendor)
        if (itemCode) {
          const inv = await ModuleInventory.findByCode(itemCode);
          if (inv) {
            const qty = parseInt(mod.count) || 1;
            await pool.query(`
              UPDATE module_inventory
              SET storage_quantity = storage_quantity + $1,
                  updated_at = CURRENT_TIMESTAMP
              WHERE item_code = $2
            `, [qty, itemCode]);

            await ModuleInventoryLog.create({
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
        await ComputingModule.delete(m.id);
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
        const toAsset = await Asset.findById(m.to_asset_id);
        if (!toAsset) continue;
        const toLabel = toAsset.management_number || toAsset.model_name || String(m.to_asset_id);

        await ComputingModule.update(m.id, {
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
          await ModuleInventoryLog.create({
            item_code: itemCode,
            event_type: 'removed',
            quantity_change: parseInt(mod.count) || 1,
            asset_id: asset.id,
            asset_label: assetLabel,
            user_id: userId,
            username: username,
            notes: '장애이동: ' + assetLabel + ' → ' + toLabel
          });
          await ModuleInventoryLog.create({
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
        await ComputingModule.delete(m.id);
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
      await ModuleTransferLog.bulkCreate(transferLogs);
    }

    // Update asset status
    if (target_status) {
      await pool.query('UPDATE assets SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
        [target_status, asset.id]);
    }

    // Recalculate inventory and sync usage logs (§5: sync는 recalculateInUse만 수행)
    await ModuleInventory.recalculateInUse();
    for (const aid of affectedAssetIds) {
      await moduleInventoryRouter.syncModulesToUsageLog(aid);
    }

    await AuditLog.log(req, {
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

// Individual module action (storage / vendor_return) (B-4d-8b, v1 L566–686 이식, 순차 실행)
router.post('/:id/module-action', requireMaintenance, async (req, res) => {
  try {
    const asset = await Asset.findById(req.params.id);
    if (!asset) return res.status(404).json({ error: '자산을 찾을 수 없습니다.' });

    const { module_id, action, reason } = req.body;
    if (!module_id || !['storage', 'vendor_return'].includes(action)) {
      return res.status(400).json({ error: '잘못된 요청입니다.' });
    }

    const mod = await ComputingModule.findById(module_id);
    if (!mod || mod.asset_id !== asset.id) {
      return res.status(404).json({ error: '모듈을 찾을 수 없습니다.' });
    }

    const assetLabel = asset.management_number || asset.model_name || String(asset.id);
    const userId = req.session.userId || null;
    const username = req.session.displayName || req.session.username || null;
    const itemCode = mod.specification || null;
    const qty = parseInt(mod.count) || 1;

    if (action === 'storage') {
      // Return to storage: increase storage_quantity (company + vendor)
      if (itemCode) {
        const inv = await ModuleInventory.findByCode(itemCode);
        if (inv) {
          await pool.query(`
            UPDATE module_inventory
            SET storage_quantity = storage_quantity + $1,
                updated_at = CURRENT_TIMESTAMP
            WHERE item_code = $2
          `, [qty, itemCode]);

          await ModuleInventoryLog.create({
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

      await ComputingModule.delete(module_id);
      await ModuleTransferLog.bulkCreate([{
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
        await ModuleInventoryLog.create({
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

      await ComputingModule.delete(module_id);
      await ModuleTransferLog.bulkCreate([{
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

    // Recalculate inventory and sync usage logs (§5: sync는 recalculateInUse만 수행)
    await ModuleInventory.recalculateInUse();
    await moduleInventoryRouter.syncModulesToUsageLog(asset.id);

    await AuditLog.log(req, {
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
    const assetCredentials = await AssetCredential.findByAssetMasked(asset.id);
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
      const existingRoom = await ServerRoom.findByNameNormalized(roomName, locType); // BL-3: 정규화 비교
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

    // BL-11 후속: id 기반 upsert(빈 password=유지). delete+bulkCreate 대체.
    const credIds = req.body['cred_ids[]'] || req.body.cred_ids || [];
    const credUsernames = req.body['cred_usernames[]'] || req.body.cred_usernames || [];
    const credPasswords = req.body['cred_passwords[]'] || req.body.cred_passwords || [];
    const credTypes = req.body['cred_types[]'] || req.body.cred_types || [];
    const credDescs = req.body['cred_descriptions[]'] || req.body.cred_descriptions || [];
    const creds = (Array.isArray(credUsernames) ? credUsernames : [credUsernames]).map((u, i) => ({
      id: (Array.isArray(credIds) ? credIds : [credIds])[i] || '',
      username: u,
      password: (Array.isArray(credPasswords) ? credPasswords : [credPasswords])[i] || '',
      credential_type: (Array.isArray(credTypes) ? credTypes : [credTypes])[i] || 'root',
      description: (Array.isArray(credDescs) ? credDescs : [credDescs])[i] || ''
    })).filter(c => c.username && c.username.trim());
    const hasCredFieldsInForm = req.body.hasOwnProperty('cred_usernames[]') || req.body.hasOwnProperty('cred_usernames') || req.body.hasOwnProperty('_cred_section_present');
    if (hasCredFieldsInForm) {
      await AssetCredential.syncForAsset(req.params.id, creds);
    }

    const afterAsset = await Asset.findById(req.params.id);

    // §5 확정(B-4d-9): v1의 assets→EUL 동기화는 영구 제거 — EUL은 이벤트 이력 전용,
    // 현재상태의 유일 소스는 assets/asset_ips/asset_credentials/computing_modules.

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
