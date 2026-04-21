const express = require('express');
const router = express.Router();
const NetworkConnection = require('../models/networkConnection');
const ServerRoom = require('../models/serverRoom');
const Rack = require('../models/rack');
const Asset = require('../models/asset');
const Vendor = require('../models/vendor');
const appConfig = require('../config/app');
const { requireMaintenance } = require('../middleware/auth');
const AuditLog = require('../models/auditLog');

// List server rooms for network layout
router.get('/', (req, res) => {
  const rooms = ServerRoom.findAll('server_room');
  rooms.forEach(room => {
    const stats = NetworkConnection.getStats(room.id);
    room.connectionCount = stats.total_connections;
    room.switchCount = stats.switch_count;
  });
  res.render('network-layout/index', {
    title: '네트워크 배치도',
    currentPath: '/network-layout',
    extraCss: 'network-layout.css',
    extraJs: null,
    rooms,
    appConfig
  });
});

// Room network layout view
router.get('/:roomId', (req, res) => {
  const room = ServerRoom.findById(req.params.roomId);
  if (!room) {
    req.flash('error', '서버실을 찾을 수 없습니다.');
    return res.redirect('/network-layout');
  }

  const racks = Rack.findByRoom(room.id);
  const allConnections = NetworkConnection.findByRoom(room.id);
  const stats = NetworkConnection.getStats(room.id);
  const assets = Asset.findAll({ room_id: room.id }).filter(a => a.status !== 'inactive' && a.status !== 'returned');
  const vendors = Vendor.findAll();

  // All switches in this room
  const switches = assets.filter(a => a.asset_type === 'switch');

  // Selected switch filter: ?sw=id1&sw=id2
  let selectedSw = req.query.sw;
  if (selectedSw && !Array.isArray(selectedSw)) selectedSw = [selectedSw];
  const selectedIds = selectedSw ? selectedSw.map(Number).filter(Boolean) : [];

  // Filter connections to only those involving selected switches
  let connections;
  if (selectedIds.length > 0) {
    connections = allConnections.filter(c =>
      selectedIds.includes(c.from_asset_id) || selectedIds.includes(c.to_asset_id)
    );
  } else {
    connections = allConnections;
  }

  // Group assets by rack
  racks.forEach(rack => {
    rack.assets = assets.filter(a => a.rack_id === rack.id);
  });

  // Build connected ports map for highlighting
  const connectedPorts = {};
  connections.forEach(c => {
    if (!connectedPorts[c.from_asset_id]) connectedPorts[c.from_asset_id] = new Set();
    connectedPorts[c.from_asset_id].add(c.from_port);
    if (!connectedPorts[c.to_asset_id]) connectedPorts[c.to_asset_id] = new Set();
    connectedPorts[c.to_asset_id].add(c.to_port);
  });

  res.render('network-layout/room', {
    title: room.name + ' - 네트워크 배치도',
    currentPath: '/network-layout',
    extraCss: 'network-layout.css',
    extraJs: null,
    room,
    racks,
    connections,
    allConnectionCount: allConnections.length,
    stats,
    assets,
    switches,
    selectedIds,
    vendors,
    connectedPorts,
    appConfig
  });
});

// Add connection
router.post('/:roomId/connections', requireMaintenance, (req, res) => {
  try {
    NetworkConnection.create({
      room_id: req.params.roomId,
      from_asset_id: req.body.from_asset_id,
      from_port: req.body.from_port,
      to_asset_id: req.body.to_asset_id,
      to_port: req.body.to_port,
      cable_type: req.body.cable_type || null,
      cable_label: req.body.cable_label || null,
      cable_color: req.body.cable_color || null,
      cable_length: req.body.cable_length || null,
      ownership: req.body.ownership || 'company',
      vendor_id: req.body.vendor_id || null,
      speed: req.body.speed || null,
      status: req.body.status || 'active',
      description: req.body.description || null
    });
    AuditLog.log(req, { action: 'create', targetType: 'network_connection', targetLabel: req.body.from_port + ' -> ' + req.body.to_port });
    req.flash('success', '연결이 추가되었습니다.');
  } catch (err) {
    req.flash('error', '추가 실패: ' + err.message);
  }
  res.redirect('/network-layout/' + req.params.roomId);
});

// Batch move connections (switch change and/or cable group change)
router.post('/connections/batch-move', requireMaintenance, (req, res) => {
  try {
    const { conn_ids, old_switch_id, new_switch_id, speed, cable_type } = req.body;
    if (!conn_ids || !Array.isArray(conn_ids) || conn_ids.length === 0) {
      return res.status(400).json({ error: '잘못된 요청입니다.' });
    }
    let switchMoved = 0;
    let fieldsChanged = 0;
    // Switch move
    if (new_switch_id && old_switch_id && Number(new_switch_id) !== Number(old_switch_id)) {
      const results = conn_ids.map(id => NetworkConnection.moveToSwitch(id, old_switch_id, new_switch_id));
      switchMoved = results.filter(r => r && r.updated).length;
    }
    // Cable group change (speed / cable_type)
    const fieldUpdates = {};
    if (speed !== undefined) fieldUpdates.speed = speed;
    if (cable_type !== undefined) fieldUpdates.cable_type = cable_type;
    if (Object.keys(fieldUpdates).length > 0) {
      fieldsChanged = NetworkConnection.batchUpdateFields(conn_ids, fieldUpdates);
    }
    res.json({ success: true, switchMoved, fieldsChanged });
  } catch (err) {
    res.status(500).json({ error: '이동 실패: ' + err.message });
  }
});

// Update connection
router.post('/connections/:id', requireMaintenance, (req, res) => {
  try {
    const conn = NetworkConnection.findById(req.params.id);
    if (!conn) {
      req.flash('error', '연결을 찾을 수 없습니다.');
      return res.redirect('/network-layout');
    }
    NetworkConnection.update(req.params.id, {
      from_asset_id: req.body.from_asset_id,
      from_port: req.body.from_port,
      to_asset_id: req.body.to_asset_id,
      to_port: req.body.to_port,
      cable_type: req.body.cable_type || null,
      cable_label: req.body.cable_label || null,
      cable_color: req.body.cable_color || null,
      cable_length: req.body.cable_length || null,
      ownership: req.body.ownership || 'company',
      vendor_id: req.body.vendor_id || null,
      speed: req.body.speed || null,
      status: req.body.status || 'active',
      description: req.body.description || null
    });
    AuditLog.log(req, { action: 'update', targetType: 'network_connection', targetId: req.params.id });
    req.flash('success', '연결이 수정되었습니다.');
    res.redirect('/network-layout/' + conn.room_id);
  } catch (err) {
    req.flash('error', '수정 실패: ' + err.message);
    res.redirect('/network-layout');
  }
});

// Delete connection
router.post('/connections/:id/delete', requireMaintenance, (req, res) => {
  try {
    const conn = NetworkConnection.findById(req.params.id);
    if (!conn) {
      req.flash('error', '연결을 찾을 수 없습니다.');
      return res.redirect('/network-layout');
    }
    const roomId = conn.room_id;
    NetworkConnection.delete(req.params.id);
    AuditLog.log(req, { action: 'delete', targetType: 'network_connection', targetId: req.params.id });
    req.flash('success', '연결이 삭제되었습니다.');
    res.redirect('/network-layout/' + roomId);
  } catch (err) {
    req.flash('error', '삭제 실패: ' + err.message);
    res.redirect('/network-layout');
  }
});

module.exports = router;
