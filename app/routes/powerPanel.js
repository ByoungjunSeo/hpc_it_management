const express = require('express');
const router = express.Router();
const PowerNode = require('../models/powerNode');
const ServerRoom = require('../models/serverRoom');
const Asset = require('../models/asset');
const appConfig = require('../config/app');
const { requireMaintenance } = require('../middleware/auth');
const AuditLog = require('../models/auditLog');

// List server rooms for power panel
router.get('/', (req, res) => {
  const rooms = ServerRoom.findAll('server_room');
  rooms.forEach(room => {
    const nodes = PowerNode.findByRoom(room.id);
    room.nodeCount = nodes.length;
  });
  res.render('power-panel/index', {
    title: '전력 분전반',
    currentPath: '/power-panel',
    extraCss: 'power-panel.css',
    extraJs: null,
    rooms,
    appConfig
  });
});

// Room power tree view
router.get('/:roomId', (req, res) => {
  const room = ServerRoom.findById(req.params.roomId);
  if (!room) {
    req.flash('error', '서버실을 찾을 수 없습니다.');
    return res.redirect('/power-panel');
  }
  const nodes = PowerNode.findByRoom(room.id);
  const tree = PowerNode.buildTree(nodes);
  const assets = Asset.findAll({ room_id: room.id });
  const pduUpsAssets = assets.filter(a => a.asset_type === 'pdu' || a.asset_type === 'ups');

  res.render('power-panel/room', {
    title: room.name + ' - 전력 분전반',
    currentPath: '/power-panel',
    extraCss: 'power-panel.css',
    extraJs: null,
    room,
    tree,
    nodes,
    pduUpsAssets,
    appConfig
  });
});

// Add node
router.post('/:roomId/nodes', requireMaintenance, (req, res) => {
  try {
    PowerNode.create({
      room_id: req.params.roomId,
      parent_id: req.body.parent_id || null,
      node_type: req.body.node_type,
      name: req.body.name,
      capacity_kw: req.body.capacity_kw || null,
      rating: req.body.rating || null,
      voltage: req.body.voltage || null,
      phase: req.body.phase || null,
      circuit_number: req.body.circuit_number || null,
      asset_id: req.body.asset_id || null,
      description: req.body.description || null,
      sort_order: req.body.sort_order || 0
    });
    AuditLog.log(req, { action: 'create', targetType: 'power_node', targetLabel: req.body.name });
    req.flash('success', '노드가 추가되었습니다.');
  } catch (err) {
    req.flash('error', '추가 실패: ' + err.message);
  }
  res.redirect('/power-panel/' + req.params.roomId);
});

// Update node
router.post('/nodes/:id', requireMaintenance, (req, res) => {
  try {
    const node = PowerNode.findById(req.params.id);
    if (!node) {
      req.flash('error', '노드를 찾을 수 없습니다.');
      return res.redirect('/power-panel');
    }
    PowerNode.update(req.params.id, {
      node_type: req.body.node_type,
      name: req.body.name,
      capacity_kw: req.body.capacity_kw || null,
      rating: req.body.rating || null,
      voltage: req.body.voltage || null,
      phase: req.body.phase || null,
      circuit_number: req.body.circuit_number || null,
      asset_id: req.body.asset_id || null,
      description: req.body.description || null,
      sort_order: req.body.sort_order || 0
    });
    AuditLog.log(req, { action: 'update', targetType: 'power_node', targetId: req.params.id, targetLabel: req.body.name });
    req.flash('success', '노드가 수정되었습니다.');
    res.redirect('/power-panel/' + node.room_id);
  } catch (err) {
    req.flash('error', '수정 실패: ' + err.message);
    res.redirect('/power-panel');
  }
});

// Delete node
router.post('/nodes/:id/delete', requireMaintenance, (req, res) => {
  try {
    const node = PowerNode.findById(req.params.id);
    if (!node) {
      req.flash('error', '노드를 찾을 수 없습니다.');
      return res.redirect('/power-panel');
    }
    const roomId = node.room_id;
    PowerNode.delete(req.params.id);
    AuditLog.log(req, { action: 'delete', targetType: 'power_node', targetId: req.params.id, targetLabel: node ? node.name : req.params.id });
    req.flash('success', '노드가 삭제되었습니다.');
    res.redirect('/power-panel/' + roomId);
  } catch (err) {
    req.flash('error', '삭제 실패: ' + err.message);
    res.redirect('/power-panel');
  }
});

module.exports = router;
