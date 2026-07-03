const express = require('express');
const router = express.Router();
const { execFile } = require('child_process');
const Rack = require('../models/rack');
const Asset = require('../models/asset');
const AuditLog = require('../models/auditLog');
const { pool } = require('../config/database');
const appConfig = require('../config/app');
const { requireMaintenance } = require('../middleware/auth');

// Rack slots API - JSON for rack preview
router.get('/:id/slots', async (req, res) => {
  try {
    const rack = await Rack.findById(req.params.id);
    if (!rack) return res.status(404).json({ error: 'Rack not found' });
    const allAssets = await Asset.findByRack(rack.id);
    const totalU = rack.total_units || 42;
    const assets = allAssets.filter(a => !a.parent_asset_id && a.rack_unit_start).map(a => ({
      id: a.id,
      name: a.model_name || a.management_number || a.asset_type,
      management_number: a.management_number || '',
      rack_unit_start: a.rack_unit_start,
      rack_unit_size: a.rack_unit_size || 3,
      blade_slot: a.blade_slot || null,
      shelf_size: a.shelf_size || 0
    }));
    res.json({ rack: { id: rack.id, name: rack.name, total_units: totalU }, assets, totalU });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// IPMI power status check for all assets in a rack
function ipmiPowerStatus(ip, user, pass) {
  return new Promise((resolve) => {
    execFile('ipmitool', ['-I', 'lanplus', '-H', ip, '-U', user, '-P', pass, 'chassis', 'power', 'status'],
      { timeout: 5000 },
      (err, stdout) => {
        if (err) {
          resolve({ status: 'error', message: '연결 실패' });
          return;
        }
        const out = stdout.trim().toLowerCase();
        if (out.includes('power is on')) resolve({ status: 'on', message: '전원 켜짐' });
        else if (out.includes('power is off')) resolve({ status: 'off', message: '전원 꺼짐' });
        else resolve({ status: 'unknown', message: out });
      }
    );
  });
}

// [BUG-2 트랙 이관] ipmiPowerControl — 전원제어는 신기능 트랙(BUG-2)에서 제공 예정
// function ipmiPowerControl(ip, user, pass, action) {
//   const validActions = ['on', 'off', 'reset', 'cycle', 'status'];
//   if (!validActions.includes(action)) {
//     return Promise.resolve({ success: false, message: '잘못된 액션: ' + action });
//   }
//   return new Promise((resolve) => {
//     execFile('ipmitool', ['-I', 'lanplus', '-H', ip, '-U', user, '-P', pass, 'chassis', 'power', action],
//       { timeout: 10000 },
//       (err, stdout, stderr) => {
//         if (err) {
//           resolve({ success: false, message: '명령 실행 실패: ' + (stderr || err.message) });
//           return;
//         }
//         resolve({ success: true, message: stdout.trim() });
//       }
//     );
//   });
// }

// Switch slots API - get occupied switch slots for immersion rack
router.get('/:id/switch-slots', async (req, res) => {
  try {
    const rack = await Rack.findById(req.params.id);
    if (!rack) return res.status(404).json({ error: 'Rack not found' });
    const excludeId = parseInt(req.query.exclude) || 0;
    let rows;
    if (excludeId) {
      ({ rows } = await pool.query(
        "SELECT id, blade_slot as slot, model_name as name, management_number as mgmt FROM assets WHERE rack_id = $1 AND blade_slot LIKE 'SW%' AND id != $2 AND status NOT IN ('decommissioned')",
        [rack.id, excludeId]
      ));
    } else {
      ({ rows } = await pool.query(
        "SELECT id, blade_slot as slot, model_name as name, management_number as mgmt FROM assets WHERE rack_id = $1 AND blade_slot LIKE 'SW%' AND status NOT IN ('decommissioned')",
        [rack.id]
      ));
    }
    res.json({ switch_slots: rack.switch_slots || 0, occupied: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/power-status', async (req, res) => {
  try {
    const rack = await Rack.findById(req.params.id);
    if (!rack) return res.status(404).json({ error: 'Rack not found' });

    const allAssets = await Asset.findByRack(rack.id);
    const results = {};

    const checkTargets = allAssets.filter(a =>
      ['server', 'storage', 'switch', 'kvm', 'other'].includes(a.asset_type)
    );

    await Promise.all(checkTargets.map(async (asset) => {
      const { rows: bmcRows } = await pool.query(
        "SELECT ip_address FROM asset_ips WHERE asset_id = $1 AND ip_type = 'bmc' LIMIT 1",
        [asset.id]
      );
      const bmcIp = bmcRows[0];

      if (!bmcIp || !bmcIp.ip_address) {
        results[asset.id] = { status: 'no_bmc', message: 'BMC 미등록' };
        return;
      }

      const { rows: credRows } = await pool.query(
        "SELECT username, password FROM asset_credentials WHERE asset_id = $1 AND credential_type = 'bmc' LIMIT 1",
        [asset.id]
      );
      const bmcCred = credRows[0];

      if (!bmcCred) {
        results[asset.id] = { status: 'no_cred', message: 'BMC 계정 미등록' };
        return;
      }

      const result = await ipmiPowerStatus(bmcIp.ip_address, bmcCred.username, bmcCred.password || '');
      result.bmc_ip = bmcIp.ip_address;
      results[asset.id] = result;
    }));

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// IPMI power control — stub (BUG-2 신기능 트랙 이관)
router.post('/:id/power-control', requireMaintenance, async (req, res) => {
  res.status(503).json({ success: false, error: '전원제어는 BUG-2 신기능 트랙에서 제공 예정' });
});

// Rack detail - 42U visualization
router.get('/:id', async (req, res) => {
  try {
    const rack = await Rack.findById(req.params.id);
    if (!rack) {
      req.flash('error', '랙을 찾을 수 없습니다.');
      return res.redirect('/rooms');
    }
    const allAssets = await Asset.findByRack(rack.id);
    const totalUnits = rack.total_units || 42;

    // Separate chassis (parent) assets from child nodes
    const childrenMap = {};
    const assets = [];

    allAssets.forEach(a => {
      if (a.parent_asset_id) {
        if (!childrenMap[a.parent_asset_id]) childrenMap[a.parent_asset_id] = [];
        childrenMap[a.parent_asset_id].push(a);
      } else {
        assets.push(a);
      }
    });

    // Also collect child nodes for chassis assets not in this rack
    for (const a of assets) {
      if (!childrenMap[a.id]) {
        const children = await Asset.findChildren(a.id);
        if (children.length > 0) childrenMap[a.id] = children;
      }
    }

    // Build U map: uMap[u] = { full, left, right }
    // BUG-5: shelfU / blade_slot render logic — v1 faithful (do NOT fix)
    const uMap = {};
    assets.forEach(a => {
      if (!a.rack_unit_start) return;
      const startSlot = a.rack_unit_start;
      const slotSize = a.rack_unit_size || 3;
      const startU = Math.floor((startSlot - 1) / 3) + 1;
      const sizeU = Math.ceil(slotSize / 3);
      const shelfU = Math.ceil((a.shelf_size || 0) / 3);
      const hasChildren = childrenMap[a.id] && childrenMap[a.id].length > 0;
      const side = hasChildren ? 'full' : (a.blade_slot || 'full');

      for (let u = startU; u < startU + sizeU; u++) {
        if (!uMap[u]) uMap[u] = { full: null, left: null, right: null };
        const info = {
          id: a.id,
          asset_type: a.asset_type,
          ownership: a.ownership,
          model_name: a.model_name || a.asset_type,
          management_number: a.management_number || '',
          assigned_user: a.assigned_user || '',
          purpose: a.purpose || '',
          ip_address: a.ip_address || '',
          rack_unit_start: a.rack_unit_start,
          rack_unit_size: a.rack_unit_size || 3,
          blade_slot: a.blade_slot,
          startU: startU,
          sizeU: sizeU,
          shelfU: shelfU,
          children: hasChildren ? childrenMap[a.id] : null
        };
        if (side === 'full') uMap[u].full = info;
        else uMap[u][side] = info;
      }
    });

    // Get connected infrastructure (CDU/chiller linked to this tank's asset)
    let connectedInfra = [];
    if (rack.linked_asset_id) {
      const { rows } = await pool.query(
        "SELECT id, asset_type, management_number, model_name, status FROM assets WHERE parent_asset_id = $1 AND asset_type IN ('cdu','chiller') ORDER BY asset_type, management_number",
        [rack.linked_asset_id]
      );
      connectedInfra = rows;
    }

    // Rack usage stats (unique U positions, blade-aware)
    const rackTypeCounts = {};
    const occupiedU = new Set();
    let companyCount = 0, vendorCount = 0;
    assets.forEach(a => {
      if (a.parent_asset_id || !a.rack_unit_start) return;
      const startU = Math.floor((a.rack_unit_start - 1) / 3) + 1;
      const sizeU = Math.ceil((a.rack_unit_size || 3) / 3);
      for (let u = startU; u < startU + sizeU; u++) occupiedU.add(u);
      const t = a.asset_type || 'other';
      rackTypeCounts[t] = (rackTypeCounts[t] || 0) + 1;
      if (a.ownership === 'vendor') vendorCount++;
      else companyCount++;
    });
    const usedU = occupiedU.size;
    const rackStats = {
      totalU: totalUnits,
      usedU,
      freeU: totalUnits - usedU,
      utilization: totalUnits > 0 ? Math.round(usedU / totalUnits * 100) : 0,
      totalAssets: assets.filter(a => !a.parent_asset_id).length,
      childAssets: allAssets.length - assets.filter(a => !a.parent_asset_id).length,
      companyCount,
      vendorCount,
      typeCounts: rackTypeCounts
    };

    res.render('racks/detail', {
      title: rack.name,
      currentPath: '/racks',
      extraCss: 'rack.css',
      extraJs: 'rack-view.js',
      rack,
      assets: allAssets,
      uMap,
      totalUnits,
      childrenMap,
      connectedInfra,
      rackStats,
      appConfig
    });
  } catch (err) {
    req.flash('error', '랙 조회 실패: ' + err.message);
    res.redirect('/rooms');
  }
});

// Move asset between switch slots (AJAX)
router.post('/:id/move-switch-slot', requireMaintenance, async (req, res) => {
  try {
    const rack = await Rack.findById(req.params.id);
    if (!rack) return res.status(404).json({ error: 'Rack not found' });

    const { asset_id, new_slot } = req.body;
    const assetId = parseInt(asset_id);
    if (!assetId || !new_slot || !/^SW\d+$/i.test(new_slot)) {
      return res.status(400).json({ error: 'Invalid parameters' });
    }

    const asset = await Asset.findById(assetId);
    if (!asset || asset.rack_id !== rack.id) {
      return res.status(400).json({ error: 'Asset not in this rack' });
    }

    // Check if target slot is occupied by another asset
    const { rows: occupants } = await pool.query(
      "SELECT id, model_name FROM assets WHERE rack_id = $1 AND blade_slot = $2 AND id != $3 AND status NOT IN ('decommissioned')",
      [rack.id, new_slot, assetId]
    );
    if (occupants.length > 0) {
      return res.status(409).json({ error: new_slot + ' 이미 사용중: ' + (occupants[0].model_name || occupants[0].id) });
    }

    // Update blade_slot
    await pool.query('UPDATE assets SET blade_slot = $1 WHERE id = $2', [new_slot, assetId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Move asset unit position within rack (AJAX)
router.post('/:id/move-asset', requireMaintenance, async (req, res) => {
  try {
    const rack = await Rack.findById(req.params.id);
    if (!rack) return res.status(404).json({ error: 'Rack not found' });

    const { asset_id, new_slot_start } = req.body;
    const assetId = parseInt(asset_id);
    const newSlotStart = parseInt(new_slot_start);
    if (!assetId || !newSlotStart) return res.status(400).json({ error: 'Invalid parameters' });

    const asset = await Asset.findById(assetId);
    if (!asset || asset.rack_id !== rack.id) return res.status(400).json({ error: 'Asset not in this rack' });

    const slotSize = asset.rack_unit_size || 3;
    const newSlotEnd = newSlotStart + slotSize - 1;
    const totalSlots = (rack.total_units || 42) * 3;

    // Bounds check
    if (newSlotStart < 1 || newSlotEnd > totalSlots) {
      return res.status(400).json({ error: 'U' + (Math.floor((newSlotStart - 1) / 3) + 1) + ' 범위 초과' });
    }

    // Collision check (slot-based)
    const allRackAssets = await Asset.findByRack(rack.id);
    for (const a of allRackAssets) {
      if (a.id === assetId || !a.rack_unit_start || a.parent_asset_id) continue;
      const aSlotStart = a.rack_unit_start;
      const aSlotEnd = aSlotStart + (a.rack_unit_size || 3) - 1;
      if (newSlotStart <= aSlotEnd && newSlotEnd >= aSlotStart) {
        // Blade exception: different blade_slot values don't collide
        if (asset.blade_slot && a.blade_slot && asset.blade_slot !== a.blade_slot) continue;
        if (!asset.blade_slot || !a.blade_slot) {
          const aU = Math.floor((a.rack_unit_start - 1) / 3) + 1;
          return res.status(409).json({ error: 'U' + aU + ' ' + (a.model_name || a.asset_type) + '와(과) 충돌' });
        }
      }
    }

    await Asset.updateUnitPosition(assetId, newSlotStart);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update rack position (AJAX)
router.post('/:id/position', requireMaintenance, async (req, res) => {
  try {
    const { row_position, col_position } = req.body;
    await Rack.updatePosition(req.params.id, parseInt(row_position) || 1, parseInt(col_position) || 1);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update rack
router.post('/:id', requireMaintenance, async (req, res) => {
  try {
    await Rack.update(req.params.id, req.body);
    req.flash('success', '랙이 수정되었습니다.');
  } catch (err) {
    req.flash('error', '수정 실패: ' + err.message);
  }
  res.redirect(req.body.returnTo || '/racks/' + req.params.id);
});

// Delete rack
router.post('/:id/delete', requireMaintenance, async (req, res) => {
  const rack = await Rack.findById(req.params.id);
  try {
    await Rack.delete(req.params.id);
    req.flash('success', '랙이 삭제되었습니다.');
  } catch (err) {
    req.flash('error', '삭제 실패: ' + err.message);
  }
  res.redirect(req.body.returnTo || req.get('Referer') || (rack ? '/rooms/' + rack.room_id : '/rooms'));
});

module.exports = router;
