const express = require('express');
const router = express.Router();
const ServerRoom = require('../models/serverRoom');
const Asset = require('../models/asset');
const ModuleInventory = require('../models/moduleInventory');
const { pool } = require('../config/database');
const appConfig = require('../config/app');

// B-8: 섀시-노드 묶음. 노드 판정은 B-6과 동일(부모가 있고 cdu/chiller가 아닌 자식 — cdu·칠러의 부모는 인프라 연결).
const BLADE_EXCLUDE_TYPES = ['cdu', 'chiller'];
const isBladeNode = (a) => !!a.parent_asset_id && !BLADE_EXCLUDE_TYPES.includes(a.asset_type);

// 목록 → 최상위 행 [{ asset, nodes, parent }]. 목록 안 섀시의 노드는 그 행의 nodes(node_index 순)로,
// 부모가 목록에 없는 노드는 단독 행으로 두고 parent(관리번호·위치)를 붙임. 최상위 순서는 원래 목록 순서 유지.
async function buildBladeRows(list) {
  const ids = list.map(a => a.id);
  const inList = new Set(ids);
  const byParent = {};
  if (ids.length) {
    const { rows: kids } = await pool.query(`
      SELECT a.* FROM assets a
      WHERE a.parent_asset_id = ANY($1) AND a.asset_type <> ALL($2)
      ORDER BY a.parent_asset_id, a.node_index NULLS LAST, a.management_number, a.id
    `, [ids, BLADE_EXCLUDE_TYPES]);
    kids.forEach(k => { (byParent[k.parent_asset_id] = byParent[k.parent_asset_id] || []).push(k); });
  }
  const orphanParentIds = [...new Set(list.filter(a => isBladeNode(a) && !inList.has(a.parent_asset_id)).map(a => a.parent_asset_id))];
  const parents = {};
  if (orphanParentIds.length) {
    const { rows: ps } = await pool.query(`
      SELECT p.id, p.management_number, p.asset_number, r.name AS rack_name,
             COALESCE(sr_direct.name, sr.name) AS room_name
      FROM assets p
      LEFT JOIN racks r ON p.rack_id = r.id
      LEFT JOIN server_rooms sr ON r.room_id = sr.id
      LEFT JOIN server_rooms sr_direct ON p.room_id = sr_direct.id
      WHERE p.id = ANY($1)
    `, [orphanParentIds]);
    ps.forEach(p => { parents[p.id] = p; });
  }
  const out = [];
  list.forEach(a => {
    if (isBladeNode(a) && inList.has(a.parent_asset_id)) return;   // 부모 섀시 행 아래에 표시
    out.push({
      asset: a,
      nodes: byParent[a.id] || [],
      parent: isBladeNode(a) ? (parents[a.parent_asset_id] || { id: a.parent_asset_id }) : null
    });
  });
  return out;
}

router.get('/', async (req, res, next) => {
  try {
    const rooms = await ServerRoom.findAll('storage');

    for (const room of rooms) {
      room.assets = await Asset.findAll({ room_id: room.id });
      room.bladeRows = await buildBladeRows(room.assets);
    }

    // Unplaced assets (no rack) and inactive/decommissioned assets
    const { rows: unplacedAssets } = await pool.query(`
      SELECT a.*, sr.name as room_name
      FROM assets a
      LEFT JOIN racks r ON a.rack_id = r.id
      LEFT JOIN server_rooms sr ON r.room_id = sr.id
      WHERE a.rack_id IS NULL AND a.status IN ('inactive', 'decommissioned')
      ORDER BY a.asset_type, a.asset_number
    `);
    const unplacedRows = await buildBladeRows(unplacedAssets);

    // Storage module inventory
    const storageModules = await ModuleInventory.findStorageModules();

    res.render('storage/index', {
      title: '장비실',
      currentPath: '/storage',
      extraCss: null,
      extraJs: null,
      rooms,
      unplacedAssets,
      unplacedRows,
      storageModules,
      appConfig
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
