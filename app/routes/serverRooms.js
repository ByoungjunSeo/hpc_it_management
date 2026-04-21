const express = require('express');
const router = express.Router();
const ServerRoom = require('../models/serverRoom');
const Rack = require('../models/rack');
const Asset = require('../models/asset');
const AssetIp = require('../models/assetIp');
const AssetCredential = require('../models/assetCredential');
const ComputingModule = require('../models/computingModule');
const ModuleInventory = require('../models/moduleInventory');
const appConfig = require('../config/app');
const { requireMaintenance } = require('../middleware/auth');
const AuditLog = require('../models/auditLog');

// List server rooms with mini rack visualization (server_room only)
router.get('/', (req, res) => {
  const rooms = ServerRoom.findAll()
    .filter(r => r.location_type === 'server_room');

  rooms.forEach(room => {
    const racks = Rack.findByRoom(room.id);
    // Room-level stats
    let roomTotalU = 0, roomUsedU = 0, roomTotalAssets = 0;
    const roomTypeCounts = {};

    racks.forEach(rack => {
      const assets = Asset.findByRack(rack.id, { includeInactive: true });
      const uMap = {};
      assets.forEach(asset => {
        if (!asset.rack_unit_start || asset.parent_asset_id) return;
        // Count stats for active assets
        if (asset.status === 'active') {
          roomTotalAssets++;
          const t = asset.asset_type || 'other';
          roomTypeCounts[t] = (roomTypeCounts[t] || 0) + 1;
        }
        const startSlot = asset.rack_unit_start;
        const slotSize = asset.rack_unit_size || 3;
        const startU = Math.floor((startSlot - 1) / 3) + 1;
        const sizeU = Math.ceil(slotSize / 3);
        const side = asset.blade_slot || 'full';
        for (let u = startU; u < startU + sizeU; u++) {
          if (!uMap[u]) uMap[u] = { full: null, left: null, right: null };
          const info = {
            asset_id: asset.id,
            asset_type: asset.asset_type,
            ownership: asset.ownership,
            status: asset.status,
            name: asset.asset_number || asset.model_name || '',
            management_number: asset.management_number || '',
            assigned_user: asset.assigned_user || '',
            purpose: asset.purpose || '',
            ip_address: asset.ip_address || '',
            blade_slot: asset.blade_slot,
            rack_unit_start: asset.rack_unit_start,
            startU: startU,
            sizeU: sizeU
          };
          if (side === 'full') uMap[u].full = info;
          else uMap[u][side] = info;
        }
      });
      rack.uMap = uMap;
      rack.totalUnits = rack.total_units || 42;
      rack.assetList = assets;
      roomTotalU += rack.totalUnits;
      roomUsedU += rack.used_units || 0;
    });
    room.racks = racks;
    room.stats = {
      totalU: roomTotalU,
      usedU: roomUsedU,
      utilization: roomTotalU > 0 ? Math.round(roomUsedU / roomTotalU * 100) : 0,
      totalAssets: roomTotalAssets,
      rackCount: racks.length,
      typeCounts: roomTypeCounts
    };
  });

  res.render('racks/rooms', {
    title: '서버실',
    currentPath: '/rooms',
    extraCss: 'rack.css',
    extraJs: null,
    rooms,
    appConfig
  });
});

// Create server room
router.post('/', requireMaintenance, (req, res) => {
  try {
    const locType = req.body.location_type || 'server_room';
    if (req.body.name && ServerRoom.findByName(req.body.name.trim(), locType)) {
      throw new Error('같은 이름의 서버실이 이미 존재합니다: ' + req.body.name);
    }
    const roomId = ServerRoom.create(req.body);
    AuditLog.log(req, { action: 'create', targetType: 'room', targetId: roomId, targetLabel: req.body.name });
    req.flash('success', '서버실이 생성되었습니다.');
  } catch (err) {
    req.flash('error', '생성 실패: ' + err.message);
  }
  res.redirect('/rooms');
});

// Edit server room
router.post('/:id/edit', requireMaintenance, (req, res) => {
  try {
    ServerRoom.update(req.params.id, req.body);
    AuditLog.log(req, { action: 'update', targetType: 'room', targetId: req.params.id, targetLabel: req.body.name });
    req.flash('success', '서버실이 수정되었습니다.');
  } catch (err) {
    req.flash('error', '수정 실패: ' + err.message);
  }
  res.redirect(req.body.returnTo || '/rooms');
});

// Server room detail - rack layout
router.get('/:id', (req, res) => {
  const room = ServerRoom.findById(req.params.id);
  if (!room) {
    req.flash('error', '서버실을 찾을 수 없습니다.');
    return res.redirect('/rooms');
  }
  const racks = Rack.findByRoom(room.id);

  // Room-level stats
  let roomTotalU = 0, roomUsedU = 0, roomTotalAssets = 0;
  const roomTypeCounts = {};
  racks.forEach(rack => {
    roomTotalU += rack.total_units || 42;
    roomUsedU += rack.used_units || 0;
    roomTotalAssets += rack.asset_count || 0;
    // Get type breakdown for this rack
    const rackAssets = Asset.findByRack(rack.id);
    rackAssets.forEach(a => {
      if (!a.parent_asset_id && a.status === 'active') {
        const t = a.asset_type || 'other';
        roomTypeCounts[t] = (roomTypeCounts[t] || 0) + 1;
      }
    });
  });
  room.stats = {
    totalU: roomTotalU,
    usedU: roomUsedU,
    utilization: roomTotalU > 0 ? Math.round(roomUsedU / roomTotalU * 100) : 0,
    totalAssets: roomTotalAssets,
    rackCount: racks.length,
    typeCounts: roomTypeCounts
  };

  // For storage-type rooms, load module inventory with storage quantities
  const storageModules = room.location_type === 'storage' ? ModuleInventory.findStorageModules() : [];
  res.render('racks/room', {
    title: room.name,
    currentPath: '/rooms',
    extraCss: 'rack.css',
    extraJs: 'rack-view.js',
    room,
    racks,
    storageModules,
    appConfig
  });
});

// Room asset list
router.get('/:id/assets', (req, res) => {
  const room = ServerRoom.findById(req.params.id);
  if (!room) {
    req.flash('error', '서버실을 찾을 수 없습니다.');
    return res.redirect('/rooms');
  }
  const assets = Asset.findAll({ room_id: req.params.id });
  assets.forEach(a => {
    a.ips = AssetIp.findByAsset(a.id);
    a.credentials = AssetCredential.findByAsset(a.id);
    a.modules = ComputingModule.findByAsset(a.id);
  });
  res.render('racks/room-assets', {
    title: room.name + ' 자산 목록',
    currentPath: '/rooms',
    extraCss: null,
    room,
    assets,
    appConfig
  });
});

// Room module overview
router.get('/:id/modules', (req, res) => {
  const room = ServerRoom.findById(req.params.id);
  if (!room) {
    req.flash('error', '서버실을 찾을 수 없습니다.');
    return res.redirect('/rooms');
  }
  const racks = Rack.findByRoom(room.id);
  racks.forEach(rack => {
    rack.assets = Asset.findByRack(rack.id);
    rack.assets.forEach(a => {
      a.modules = ComputingModule.findByAsset(a.id);
    });
  });
  res.render('racks/room-modules', {
    title: room.name + ' 모듈 현황',
    currentPath: '/rooms',
    extraCss: null,
    room,
    racks,
    appConfig
  });
});

// Add rack to room
router.post('/:id/racks', requireMaintenance, (req, res) => {
  try {
    const rackId = Rack.create({ ...req.body, room_id: req.params.id });
    AuditLog.log(req, { action: 'create', targetType: 'rack', targetId: rackId, targetLabel: req.body.name });
    req.flash('success', '랙이 추가되었습니다.');
  } catch (err) {
    req.flash('error', '추가 실패: ' + err.message);
  }
  res.redirect('/rooms/' + req.params.id);
});

// Delete room
router.post('/:id/delete', requireMaintenance, (req, res) => {
  const room = ServerRoom.findById(req.params.id);
  try {
    ServerRoom.delete(req.params.id);
    AuditLog.log(req, { action: 'delete', targetType: 'room', targetId: req.params.id, targetLabel: room ? room.name : req.params.id });
    req.flash('success', '서버실이 삭제되었습니다.');
  } catch (err) {
    req.flash('error', '삭제 실패: ' + err.message);
  }
  res.redirect('/rooms');
});

module.exports = router;
