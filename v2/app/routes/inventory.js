const express = require('express');
const router = express.Router();
const EquipmentUsageLog = require('../models/equipmentUsageLog');
const ModuleInventory = require('../models/moduleInventory');
const ModuleInventoryLog = require('../models/moduleInventoryLog');
const ServerRoom = require('../models/serverRoom');
const Rack = require('../models/rack');
const Asset = require('../models/asset');
const AssetIp = require('../models/assetIp');
const AssetCredential = require('../models/assetCredential');
const ComputingModule = require('../models/computingModule');
const Photo = require('../models/photo');
const Vendor = require('../models/vendor');
const AuditLog = require('../models/auditLog');
const appConfig = require('../config/app');
const { requireMaintenance } = require('../middleware/auth');
const { pool } = require('../config/database');
const { generateVendorManagementNumber } = require('../utils/inventoryHelpers');

// B-4d-6c-A: 무접촉 7EP(#2,4,5,6,7,8,17) / 6c-B: 읽기 5EP(#1,9,11,12,16) / 6c-C1: 반납·삭제(#14,15) 구현.
// 남은 스텁: #3(입고),#10(사용등록),#13(수정) = 6c-C2~4 / #18(migrate-psu) = 일회성, v2 불필요로 스텁 확정.
const notImplemented = (req, res) => {
  res.status(501).json({ error: '미구현 - B-4d-6c 후속 조각' });
};

// EP#1: Inventory list (EUL 읽기 — 6a flatten이 status/개별컬럼 가상필드 제공)
router.get('/', async (req, res, next) => {
  try {
    const tab = req.query.tab || 'equipment';

    if (tab === 'module') {
      // Module tab: load from module_inventory_logs
      const moduleFilters = {
        event_type: req.query.event_type,
        item_code: req.query.item_code,
        date_from: req.query.date_from,
        date_to: req.query.date_to,
        search: req.query.search
      };
      const moduleLogs = await ModuleInventoryLog.findAll(moduleFilters, 500);
      const moduleCounts = await ModuleInventoryLog.countByEventType();
      const itemCodes = await ModuleInventoryLog.getItemCodes();
      const eventTypes = ['incoming', 'installed', 'removed', 'outgoing', 'adjust'];

      res.render('inventory/index', {
        title: '입출고 관리',
        currentPath: '/inventory',
        extraCss: null,
        extraJs: null,
        tab,
        moduleLogs,
        moduleCounts,
        itemCodes,
        eventTypes,
        moduleFilters,
        appConfig
      });
    } else {
      // Equipment tab: equipment_usage_logs excluding modules
      const filters = {
        status: req.query.status,
        room: req.query.room,
        user_name: req.query.user_name,
        ownership: req.query.ownership,
        date_from: req.query.date_from,
        date_to: req.query.date_to,
        search: req.query.search
      };
      const logs = await EquipmentUsageLog.findAllEquipment(filters);
      const counts = await EquipmentUsageLog.countByStatusEquipment();
      const rooms = await EquipmentUsageLog.getRoomsEquipment();
      const users = await EquipmentUsageLog.getUsersEquipment();

      res.render('inventory/index', {
        title: '입출고 관리',
        currentPath: '/inventory',
        extraCss: null,
        extraJs: null,
        tab,
        logs,
        counts,
        rooms,
        users,
        filters,
        appConfig
      });
    }
  } catch (err) {
    next(err);
  }
});

// === Incoming Registration (입고 등록) ===

// EP#2: GET /incoming - incoming registration form
router.get('/incoming', async (req, res, next) => {
  try {
    const vendors = await Vendor.findAll();
    const moduleInventoryItems = await ModuleInventory.findAll();

    res.render('inventory/incoming-form', {
      title: '입고 등록',
      currentPath: '/inventory',
      extraCss: null,
      extraJs: null,
      vendors,
      moduleInventoryItems,
      appConfig
    });
  } catch (err) {
    next(err);
  }
});

// EP#3: POST /incoming - create incoming record (EUL 쓰기) — 스텁
router.post('/incoming', requireMaintenance, notImplemented);

// EP#4: API: get next vendor management number (for preview)
router.get('/api/vendor-mgmt-number', async (req, res) => {
  try {
    let vendorName = 'VND';
    if (req.query.vendor_name) {
      vendorName = req.query.vendor_name.trim();
    } else if (req.query.vendor_id) {
      const v = await Vendor.findById(req.query.vendor_id);
      if (v) vendorName = v.vendor_name;
    }
    res.json({ management_number: await generateVendorManagementNumber(vendorName) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// EP#5: API: get returned (inactive) assets for a vendor (for re-incoming datalist)
router.get('/api/vendor-returned-assets', async (req, res) => {
  try {
    const vendorId = req.query.vendor_id;
    if (!vendorId) return res.json({ assets: [] });
    const { rows } = await pool.query(
      "SELECT id, management_number, model_name, asset_type FROM assets WHERE vendor_id = $1 AND status IN ('inactive','returned') ORDER BY management_number",
      [vendorId]
    );
    res.json({ assets: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// EP#6: API: get next management number suggestions by asset type
router.get('/api/next-mgmt-number', async (req, res) => {
  try {
    const assetType = req.query.asset_type;
    if (!assetType) return res.json({ suggestions: [], recent: [] });

    const { rows } = await pool.query(
      "SELECT management_number FROM assets WHERE asset_type = $1 AND management_number IS NOT NULL AND management_number != ''",
      [assetType]
    );

    // Group by prefix: split management_number into prefix + trailing number
    const prefixMap = {}; // prefix -> { numbers: [], padLen }
    const re = /^(.+?)(\d+)$/;
    rows.forEach(row => {
      const m = row.management_number.match(re);
      if (m) {
        const prefix = m[1];
        const num = parseInt(m[2], 10);
        const padLen = m[2].length;
        if (!prefixMap[prefix]) prefixMap[prefix] = { numbers: [], padLen };
        prefixMap[prefix].numbers.push(num);
        // Track max pad length seen
        if (m[2].length > prefixMap[prefix].padLen) {
          prefixMap[prefix].padLen = m[2].length;
        }
      }
    });

    // Build suggestions sorted by count descending
    const suggestions = Object.entries(prefixMap).map(([prefix, data]) => {
      const maxNum = Math.max(...data.numbers);
      const nextNum = maxNum + 1;
      const padLen = data.padLen;
      return {
        prefix,
        last: prefix + String(maxNum).padStart(padLen, '0'),
        next: prefix + String(nextNum).padStart(padLen, '0'),
        count: data.numbers.length
      };
    }).sort((a, b) => b.count - a.count);

    // Recent management numbers (last 5 created)
    const { rows: recentRows } = await pool.query(
      "SELECT management_number FROM assets WHERE asset_type = $1 AND management_number IS NOT NULL AND management_number != '' ORDER BY id DESC LIMIT 5",
      [assetType]
    );
    const recent = recentRows.map(r => r.management_number);

    res.json({ suggestions, recent });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// EP#7: API: check if management number already exists
router.get('/api/check-mgmt-number', async (req, res) => {
  try {
    const mgmtNumber = req.query.management_number;
    if (!mgmtNumber) return res.json({ exists: false });

    const { rows } = await pool.query(
      "SELECT id, management_number, status, model_name, ownership FROM assets WHERE management_number = $1",
      [mgmtNumber]
    );
    const row = rows[0];
    if (!row) return res.json({ exists: false });
    // inactive/returned asset → re-incoming possible
    if (row.status === 'inactive' || row.status === 'returned') {
      return res.json({ exists: true, reIncoming: true, asset: { id: row.id, status: row.status, model_name: row.model_name, ownership: row.ownership } });
    }
    res.json({ exists: true, reIncoming: false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// EP#8: API: get module inventory items by type (for AJAX)
router.get('/api/modules/:type', async (req, res) => {
  try {
    const items = await ModuleInventory.findAll(req.params.type);
    res.json(items);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// EP#16: Asset detail API (AJAX for auto-fill)
// ★ /api/* 구체 경로는 /:id 동적 경로보다 먼저 등록 (매칭 순서)
router.get('/api/asset/:id', async (req, res) => {
  try {
    const asset = await Asset.findById(req.params.id);
    if (!asset) return res.status(404).json({ error: 'Not found' });
    const ips = await AssetIp.findByAsset(req.params.id);
    const credentials = await AssetCredential.findByAsset(req.params.id);

    // Include parent chassis info if this is a node asset
    let parent = null;
    if (asset.parent_asset_id) {
      parent = await Asset.findById(asset.parent_asset_id);
    }

    // Include child nodes if this is a chassis
    const children = await Asset.findChildren(asset.id);

    // Include hardware data: try latest usage log hardware_json first, then computing_modules
    let hardware = [];
    if (asset.management_number) {
      const latestLog = await EquipmentUsageLog.getLatestByManagement(asset.management_number);
      if (latestLog && latestLog.hardware_json) {
        try { hardware = JSON.parse(latestLog.hardware_json); } catch (e) {}
      }
    }
    if (hardware.length === 0) {
      // Fallback: build from computing_modules
      const modules = await ComputingModule.findByAsset(asset.id);
      modules.forEach(m => {
        const item = { type: m.module_type, code: m.model || '', num: m.count || 1, ownership: m.owner || 'company' };
        if (m.notes && m.module_type === 'psu') item.role = m.notes;
        hardware.push(item);
      });
    }

    res.json({ asset, ips, credentials, parent, children, hardware });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// EP#17: Component spec API (AJAX)
router.get('/api/component/:code', async (req, res) => {
  try {
    const spec = await ModuleInventory.findByCode(req.params.code);
    if (!spec) return res.status(404).json({ error: 'Not found' });
    res.json(spec);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// EP#18: One-time migration: add default PSU entries (EUL 쓰기) — 스텁
router.post('/api/migrate-psu', requireMaintenance, notImplemented);

// EP#9: New usage registration form (EUL prefill)
router.get('/new', async (req, res, next) => {
  try {
    const mgmt = req.query.mgmt;
    let prefill = null;
    if (mgmt) {
      prefill = await EquipmentUsageLog.getLatestByManagement(mgmt);
    }

    const componentTypes = await ModuleInventory.findAll();
    const serverRooms = await ServerRoom.findAll();
    const racks = await Rack.findAll();
    const assets = await Asset.findAll();
    const moduleInventoryItems = await ModuleInventory.findAll();

    res.render('inventory/form', {
      title: '사용 등록',
      currentPath: '/inventory',
      extraCss: 'rack.css',
      extraJs: null,
      log: prefill,
      isEdit: false,
      componentTypes,
      serverRooms,
      racks,
      assets,
      moduleInventoryItems,
      appConfig
    });
  } catch (err) {
    next(err);
  }
});

// EP#10: Create usage (EUL 쓰기 + 자산 동기화) — 스텁
router.post('/', requireMaintenance, notImplemented);

// EP#11: Equipment detail by management number (EUL 이력 시퀀스)
router.get('/equipment/:mgmt', async (req, res, next) => {
  try {
    const mgmt = req.params.mgmt;
    const history = await EquipmentUsageLog.getHistory(mgmt);
    if (history.length === 0) {
      req.flash('error', '해당 관리번호의 기록이 없습니다.');
      return res.redirect('/inventory');
    }
    const latest = history[history.length - 1];

    // Look up component specs from module_inventory
    const componentSpecs = {};
    // From hardware_json if present
    if (latest.hardware_json) {
      try {
        const hwItems = JSON.parse(latest.hardware_json);
        for (const h of hwItems) {
          if (h.code && h.code !== '-' && !componentSpecs[h.code]) {
            const spec = await ModuleInventory.findByCode(h.code);
            if (spec) componentSpecs[h.code] = spec;
          }
        }
      } catch (e) {}
    }
    // Also check legacy columns (flatten 가상필드)
    const compFields = [
      'cpu_type', 'mem1_type', 'mem2_type',
      'disk1_part', 'disk2_part', 'disk3_part', 'disk4_part',
      'nic1_type', 'nic2_type', 'nic3_type', 'nic4_type',
      'raid_type', 'gpu1_type', 'gpu2_type'
    ];
    for (const f of compFields) {
      const code = latest[f];
      if (code && code !== '-' && !componentSpecs[code]) {
        const spec = await ModuleInventory.findByCode(code);
        if (spec) componentSpecs[code] = spec;
      }
    }

    // 자산에 연결된 computing_modules 조회
    const linkedAsset = await Asset.findByManagementNumber(mgmt);
    const computingModules = linkedAsset ? await ComputingModule.findByAsset(linkedAsset.id) : [];
    const moduleTransferLogs = linkedAsset ? await ModuleInventoryLog.findByAsset(linkedAsset.id) : [];
    const detailPhotos = linkedAsset ? await Photo.findByAssetWithUsageLogs(linkedAsset.id, mgmt) : [];

    res.render('inventory/equipment-detail', {
      title: mgmt + ' 장비 상세',
      currentPath: '/inventory',
      extraCss: null,
      extraJs: null,
      mgmt,
      latest,
      history,
      componentSpecs,
      computingModules,
      linkedAsset,
      moduleTransferLogs,
      detailPhotos,
      appConfig
    });
  } catch (err) {
    next(err);
  }
});

// EP#12: Edit form (EUL 읽기, 수정 모드)
router.get('/:id/edit', async (req, res, next) => {
  try {
    const log = await EquipmentUsageLog.findById(req.params.id);
    if (!log) {
      req.flash('error', '기록을 찾을 수 없습니다.');
      return res.redirect('/inventory');
    }
    const componentTypes = await ModuleInventory.findAll();
    const serverRooms = await ServerRoom.findAll();
    const racks = await Rack.findAll();
    const assets = await Asset.findAll();
    const moduleInventoryItems = await ModuleInventory.findAll();

    // Find linked asset to get blade_slot for switch slot pre-selection
    let linkedAssetBladeSlot = '';
    let linkedAssetId = null;
    if (log.management_number) {
      const linkedAsset = await Asset.findByManagementNumber(log.management_number);
      if (linkedAsset) {
        linkedAssetBladeSlot = linkedAsset.blade_slot || '';
        linkedAssetId = linkedAsset.id;
      }
    }

    const logPhotos = await Photo.findByEntity('equipment_usage', log.id);
    res.render('inventory/form', {
      title: '수정',
      currentPath: '/inventory',
      extraCss: 'rack.css',
      extraJs: null,
      log,
      isEdit: true,
      logPhotos,
      componentTypes,
      serverRooms,
      racks,
      assets,
      moduleInventoryItems,
      appConfig,
      linkedAssetBladeSlot,
      linkedAssetId,
      returnTo: req.query.returnTo || req.get('Referer') || ''
    });
  } catch (err) {
    next(err);
  }
});

// EP#13: Update (EUL 쓰기) — 스텁
router.post('/:id', requireMaintenance, notImplemented);

// EP#14: Return 반납 — 설계 §5: 6a markReturned가 returned 이벤트 append INSERT (UPDATE 아님)
router.post('/:id/return', requireMaintenance, async (req, res) => {
  try {
    const returnDate = req.body.return_date || new Date().toISOString().split('T')[0];
    // Get usage log to find management_number
    const log = await EquipmentUsageLog.findById(req.params.id);
    await EquipmentUsageLog.markReturned(req.params.id, returnDate);

    // Update linked asset: status → inactive, clear rack placement
    if (log && log.management_number) {
      const asset = await Asset.findByManagementNumber(log.management_number);
      if (asset) {
        await Asset.markReturned(asset.id);
        await AuditLog.log(req, {
          action: 'update', targetType: 'asset', targetId: asset.id,
          targetLabel: log.management_number,
          details: { reason: '반납처리', previousStatus: asset.status, previousRackId: asset.rack_id }
        });
      }
    }

    await AuditLog.log(req, { action: 'update', targetType: 'equipment_usage', targetId: req.params.id, targetLabel: '반납처리' });
    req.flash('success', '반납 처리가 완료되었습니다.');
  } catch (err) {
    req.flash('error', '반납 실패: ' + err.message);
  }
  res.redirect(req.body.returnTo || req.get('Referer') || '/inventory');
});

// EP#15: Delete — 설계 §5: DELETE 충실이식 (B-4d-2.5 트리거 제거로 가능)
router.post('/:id/delete', requireMaintenance, async (req, res) => {
  try {
    await Photo.deleteByEntity('equipment_usage', parseInt(req.params.id));
    await EquipmentUsageLog.delete(req.params.id);
    await AuditLog.log(req, { action: 'delete', targetType: 'equipment_usage', targetId: req.params.id });
    req.flash('success', '기록이 삭제되었습니다.');
  } catch (err) {
    req.flash('error', '삭제 실패: ' + err.message);
  }
  res.redirect(req.body.returnTo || req.get('Referer') || '/inventory');
});

module.exports = router;
