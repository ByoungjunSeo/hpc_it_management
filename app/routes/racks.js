const express = require('express');
const router = express.Router();
const { execFile } = require('child_process');
const Rack = require('../models/rack');
const Asset = require('../models/asset');
const AuditLog = require('../models/auditLog');
const { getDb } = require('../config/database');
const appConfig = require('../config/app');
const { requireMaintenance } = require('../middleware/auth');

// Rack slots API - JSON for rack preview
router.get('/:id/slots', (req, res) => {
  try {
    const rack = Rack.findById(req.params.id);
    if (!rack) return res.status(404).json({ error: 'Rack not found' });
    const allAssets = Asset.findByRack(rack.id);
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

function ipmiPowerControl(ip, user, pass, action) {
  const validActions = ['on', 'off', 'reset', 'cycle', 'status'];
  if (!validActions.includes(action)) {
    return Promise.resolve({ success: false, message: '잘못된 액션: ' + action });
  }
  return new Promise((resolve) => {
    execFile('ipmitool', ['-I', 'lanplus', '-H', ip, '-U', user, '-P', pass, 'chassis', 'power', action],
      { timeout: 10000 },
      (err, stdout, stderr) => {
        if (err) {
          resolve({ success: false, message: '명령 실행 실패: ' + (stderr || err.message) });
          return;
        }
        resolve({ success: true, message: stdout.trim() });
      }
    );
  });
}

// Switch slots API - get occupied switch slots for immersion rack
router.get('/:id/switch-slots', (req, res) => {
  try {
    const rack = Rack.findById(req.params.id);
    if (!rack) return res.status(404).json({ error: 'Rack not found' });
    const excludeId = parseInt(req.query.exclude) || 0;
    let occupied;
    if (excludeId) {
      occupied = getDb().prepare(
        "SELECT id, blade_slot as slot, model_name as name, management_number as mgmt FROM assets WHERE rack_id = ? AND blade_slot LIKE 'SW%' AND id != ? AND status NOT IN ('decommissioned')"
      ).all(rack.id, excludeId);
    } else {
      occupied = getDb().prepare(
        "SELECT id, blade_slot as slot, model_name as name, management_number as mgmt FROM assets WHERE rack_id = ? AND blade_slot LIKE 'SW%' AND status NOT IN ('decommissioned')"
      ).all(rack.id);
    }
    res.json({ switch_slots: rack.switch_slots || 0, occupied });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/power-status', async (req, res) => {
  try {
    const rack = Rack.findById(req.params.id);
    if (!rack) return res.status(404).json({ error: 'Rack not found' });

    const db = getDb();
    const allAssets = Asset.findByRack(rack.id);
    const results = {};

    const checkTargets = allAssets.filter(a =>
      ['server', 'storage', 'switch', 'kvm', 'other'].includes(a.asset_type)
    );

    await Promise.all(checkTargets.map(async (asset) => {
      const bmcIp = db.prepare(
        "SELECT ip_address FROM asset_ips WHERE asset_id = ? AND ip_type = 'bmc' LIMIT 1"
      ).get(asset.id);

      if (!bmcIp || !bmcIp.ip_address) {
        results[asset.id] = { status: 'no_bmc', message: 'BMC 미등록' };
        return;
      }

      let bmcCred = db.prepare(
        "SELECT username, password FROM asset_credentials WHERE asset_id = ? AND credential_type = 'bmc' LIMIT 1"
      ).get(asset.id);

      // Fallback: try ADMIN/ADMIN (common BMC default)
      const user = bmcCred ? bmcCred.username : 'ADMIN';
      const pass = bmcCred ? (bmcCred.password || 'ADMIN') : 'ADMIN';

      const result = await ipmiPowerStatus(bmcIp.ip_address, user, pass);
      result.bmc_ip = bmcIp.ip_address;
      results[asset.id] = result;
    }));

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// IPMI power control for a single asset
router.post('/:id/power-control', async (req, res) => {
  try {
    const rack = Rack.findById(req.params.id);
    if (!rack) return res.status(404).json({ error: 'Rack not found' });

    const { assetId, action } = req.body;
    if (!assetId || !action) return res.status(400).json({ error: 'assetId와 action이 필요합니다.' });

    const validActions = ['on', 'off', 'reset', 'cycle'];
    if (!validActions.includes(action)) return res.status(400).json({ error: '잘못된 액션: ' + action });

    const asset = Asset.findById(assetId);
    if (!asset) return res.status(404).json({ error: 'Asset not found' });

    const db = getDb();
    const bmcIp = db.prepare(
      "SELECT ip_address FROM asset_ips WHERE asset_id = ? AND ip_type = 'bmc' LIMIT 1"
    ).get(assetId);

    if (!bmcIp || !bmcIp.ip_address) {
      return res.status(400).json({ error: 'BMC IP가 등록되지 않았습니다.' });
    }

    let bmcCred = db.prepare(
      "SELECT username, password FROM asset_credentials WHERE asset_id = ? AND credential_type = 'bmc' LIMIT 1"
    ).get(assetId);

    const user = bmcCred ? bmcCred.username : 'ADMIN';
    const pass = bmcCred ? (bmcCred.password || 'ADMIN') : 'ADMIN';

    const result = await ipmiPowerControl(bmcIp.ip_address, user, pass, action);

    // Get updated power status after control
    let status = null;
    if (result.success) {
      // Brief delay for state to settle
      await new Promise(r => setTimeout(r, 1000));
      const statusResult = await ipmiPowerStatus(bmcIp.ip_address, user, pass);
      status = statusResult.status;
    }

    const actionLabels = { on: '전원 켜기', off: '전원 끄기', reset: '재시작', cycle: '전원 순환' };
    AuditLog.log(req, {
      action: 'power_control',
      targetType: 'asset',
      targetId: assetId,
      targetLabel: asset.management_number || asset.model_name || ('Asset #' + assetId),
      details: {
        rack_id: rack.id,
        rack_name: rack.name,
        bmc_ip: bmcIp.ip_address,
        power_action: action,
        action_label: actionLabels[action],
        success: result.success,
        message: result.message,
        new_status: status
      }
    });

    res.json({
      success: result.success,
      action: action,
      status: status,
      message: result.success
        ? actionLabels[action] + ' 완료'
        : '실패: ' + result.message
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Rack detail - 42U visualization
router.get('/:id', (req, res) => {
  const rack = Rack.findById(req.params.id);
  if (!rack) {
    req.flash('error', '랙을 찾을 수 없습니다.');
    return res.redirect('/rooms');
  }
  const allAssets = Asset.findByRack(rack.id);
  const totalUnits = rack.total_units || 42;

  // Separate chassis (parent) assets from child nodes
  // Child nodes (with parent_asset_id) are shown inside their chassis, not as separate rack items
  const childrenMap = {}; // parentId -> [child assets]
  const assets = []; // assets to show in rack (excludes child nodes)

  allAssets.forEach(a => {
    if (a.parent_asset_id) {
      if (!childrenMap[a.parent_asset_id]) childrenMap[a.parent_asset_id] = [];
      childrenMap[a.parent_asset_id].push(a);
    } else {
      assets.push(a);
    }
  });

  // Also collect child nodes for chassis assets not in this rack
  // (chassis may have children that aren't in allAssets)
  assets.forEach(a => {
    if (!childrenMap[a.id]) {
      const children = Asset.findChildren(a.id);
      if (children.length > 0) childrenMap[a.id] = children;
    }
  });

  // Build U map: uMap[u] = { full, left, right }
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
    connectedInfra = getDb().prepare(
      "SELECT id, asset_type, management_number, model_name, status FROM assets WHERE parent_asset_id = ? AND asset_type IN ('cdu','chiller') ORDER BY asset_type, management_number"
    ).all(rack.linked_asset_id);
  }

  // Rack usage stats
  const rackTypeCounts = {};
  let usedU = 0;
  let companyCount = 0, vendorCount = 0;
  assets.forEach(a => {
    if (a.parent_asset_id || !a.rack_unit_start) return;
    usedU += Math.ceil((a.rack_unit_size || 3) / 3);
    const t = a.asset_type || 'other';
    rackTypeCounts[t] = (rackTypeCounts[t] || 0) + 1;
    if (a.ownership === 'vendor') vendorCount++;
    else companyCount++;
  });
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
});

// Move asset between switch slots (AJAX)
router.post('/:id/move-switch-slot', requireMaintenance, (req, res) => {
  try {
    const rack = Rack.findById(req.params.id);
    if (!rack) return res.status(404).json({ error: 'Rack not found' });

    const { asset_id, new_slot } = req.body;
    const assetId = parseInt(asset_id);
    if (!assetId || !new_slot || !/^SW\d+$/i.test(new_slot)) {
      return res.status(400).json({ error: 'Invalid parameters' });
    }

    const asset = Asset.findById(assetId);
    if (!asset || asset.rack_id !== rack.id) {
      return res.status(400).json({ error: 'Asset not in this rack' });
    }

    // Check if target slot is occupied by another asset
    const occupant = getDb().prepare(
      "SELECT id, model_name FROM assets WHERE rack_id = ? AND blade_slot = ? AND id != ? AND status NOT IN ('decommissioned')"
    ).get(rack.id, new_slot, assetId);
    if (occupant) {
      return res.status(409).json({ error: new_slot + ' 이미 사용중: ' + (occupant.model_name || occupant.id) });
    }

    // Update blade_slot
    getDb().prepare('UPDATE assets SET blade_slot = ? WHERE id = ?').run(new_slot, assetId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Move asset unit position within rack (AJAX)
router.post('/:id/move-asset', requireMaintenance, (req, res) => {
  try {
    const rack = Rack.findById(req.params.id);
    if (!rack) return res.status(404).json({ error: 'Rack not found' });

    const { asset_id, new_slot_start } = req.body;
    const assetId = parseInt(asset_id);
    const newSlotStart = parseInt(new_slot_start);
    if (!assetId || !newSlotStart) return res.status(400).json({ error: 'Invalid parameters' });

    const asset = Asset.findById(assetId);
    if (!asset || asset.rack_id !== rack.id) return res.status(400).json({ error: 'Asset not in this rack' });

    const slotSize = asset.rack_unit_size || 3;
    const newSlotEnd = newSlotStart + slotSize - 1;
    const totalSlots = (rack.total_units || 42) * 3;

    // Bounds check
    if (newSlotStart < 1 || newSlotEnd > totalSlots) {
      return res.status(400).json({ error: 'U' + (Math.floor((newSlotStart - 1) / 3) + 1) + ' 범위 초과' });
    }

    // Collision check (slot-based)
    // Skip child nodes (they don't occupy rack slots directly)
    const allRackAssets = Asset.findByRack(rack.id);
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

    Asset.updateUnitPosition(assetId, newSlotStart);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update rack position (AJAX)
router.post('/:id/position', requireMaintenance, (req, res) => {
  try {
    const { row_position, col_position } = req.body;
    Rack.updatePosition(req.params.id, parseInt(row_position) || 1, parseInt(col_position) || 1);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update rack
router.post('/:id', requireMaintenance, (req, res) => {
  try {
    Rack.update(req.params.id, req.body);
    req.flash('success', '랙이 수정되었습니다.');
  } catch (err) {
    req.flash('error', '수정 실패: ' + err.message);
  }
  res.redirect(req.body.returnTo || '/racks/' + req.params.id);
});

// Delete rack
router.post('/:id/delete', requireMaintenance, (req, res) => {
  const rack = Rack.findById(req.params.id);
  try {
    Rack.delete(req.params.id);
    req.flash('success', '랙이 삭제되었습니다.');
  } catch (err) {
    req.flash('error', '삭제 실패: ' + err.message);
  }
  res.redirect(req.body.returnTo || req.get('Referer') || (rack ? '/rooms/' + rack.room_id : '/rooms'));
});

module.exports = router;
