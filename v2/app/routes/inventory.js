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
const upload = require('../middleware/upload');
const appConfig = require('../config/app');
const { requireMaintenance } = require('../middleware/auth');
const { pool } = require('../config/database');
const IpAddress = require('../models/ipAddress');
const {
  generateVendorManagementNumber,
  mapHardwareToCols,
  mapIpsToCols,
  mapCredsToCols,
  normalizePurpose
} = require('../utils/inventoryHelpers');

// B-4d-6c-A: 무접촉 7EP(#2,4,5,6,7,8,17) / 6c-B: 읽기 5EP(#1,9,11,12,16) / 6c-C1: #14,15 / 6c-C2: #3 / 6c-C3: #10 구현.
// 남은 스텁: #13(수정) = 6c-C4 / #18(migrate-psu) = 일회성, v2 불필요로 스텁 확정.
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

// EP#3: POST /incoming - create incoming record
// status='입고' → 6a EUL.create가 STATUS_TO_EVENT로 event_type='incoming' 매핑
router.post('/incoming', requireMaintenance, upload.array('photos', 10), async (req, res) => {
  try {
    const assetType = req.body.asset_type;
    const moduleTypeValues = appConfig.moduleTypes.map(t => t.value);
    const isModule = moduleTypeValues.includes(assetType);
    const today = new Date().toISOString().split('T')[0];
    let baseMgmt;
    let itemCode;

    // Handle new vendor creation
    let vendorId = req.body.vendor_id || null;
    if (vendorId === '__new__' && req.body.new_vendor_name) {
      vendorId = await Vendor.create({ vendor_name: req.body.new_vendor_name });
    } else if (vendorId === '__new__') {
      vendorId = null;
    }

    if (isModule) {
      // Module incoming: upsert into module_inventory
      itemCode = (req.body.management_number || '').trim();
      const quantity = parseInt(req.body.quantity) || 1;

      // 업체 부품인데 부품코드가 비어있으면 자동 생성
      if (!itemCode && req.body.ownership === 'vendor' && vendorId) {
        const vendor = await Vendor.findById(vendorId);
        if (vendor) {
          const typeLabels = { cpu: 'CPU', memory: '메모리', disk: '스토리지', network: '네트워크', raid: 'RAID', gpu: 'GPU', cable: '케이블', psu: 'PSU' };
          const typeName = typeLabels[assetType] || assetType;
          const prefix = vendor.vendor_name + '-' + typeName + '-';
          const oldPrefix = vendor.vendor_name + '-부품-' + typeName + '-';
          const { rows } = await pool.query(
            'SELECT item_code FROM module_inventory WHERE item_code ILIKE $1 OR item_code ILIKE $2',
            [prefix + '%', oldPrefix + '%']
          );
          let maxNum = 0;
          for (const row of rows) {
            const suffix = row.item_code.startsWith(oldPrefix) ? oldPrefix : prefix;
            const num = parseInt(row.item_code.substring(suffix.length));
            if (!isNaN(num) && num > maxNum) maxNum = num;
          }
          itemCode = prefix + String(maxNum + 1).padStart(3, '0');
        }
      }
      const incomingAssetNumber = req.body.asset_number || null;

      // Check if existing
      const existing = await ModuleInventory.findByCode(itemCode);
      const beforeTotal = existing ? existing.total_quantity : 0;
      const beforeSpare = existing ? existing.spare_quantity : 0;

      const moduleOwner = req.body.ownership || 'company';
      const moduleVendorId = vendorId || null;

      if (existing) {
        // Increase total and spare quantities
        await ModuleInventory.upsert({
          module_type: assetType,
          item_code: itemCode,
          label: existing.label,
          manufacturer: req.body.manufacturer || existing.manufacturer,
          model: req.body.model_name || existing.model,
          capacity: req.body.capacity || existing.capacity,
          specification: req.body.specification || existing.specification,
          total_quantity: existing.total_quantity + quantity,
          in_use_quantity: existing.in_use_quantity,
          spare_quantity: existing.spare_quantity + quantity,
          storage_quantity: existing.storage_quantity + quantity,
          asset_number: incomingAssetNumber,
          owner: moduleOwner,
          owner_vendor_id: moduleVendorId
        });
      } else {
        // New module inventory entry
        await ModuleInventory.upsert({
          module_type: assetType,
          item_code: itemCode,
          label: req.body.model_name || itemCode,
          manufacturer: req.body.manufacturer || null,
          model: req.body.model_name || null,
          capacity: req.body.capacity || null,
          specification: req.body.specification || null,
          total_quantity: quantity,
          in_use_quantity: 0,
          spare_quantity: quantity,
          storage_quantity: quantity,
          asset_number: incomingAssetNumber,
          owner: moduleOwner,
          owner_vendor_id: moduleVendorId
        });
      }

      // Log incoming event
      const afterTotal = beforeTotal + quantity;
      const afterSpare = beforeSpare + quantity;
      await ModuleInventoryLog.create({
        item_code: itemCode,
        event_type: 'incoming',
        quantity_change: quantity,
        before_total: beforeTotal,
        after_total: afterTotal,
        before_spare: beforeSpare,
        after_spare: afterSpare,
        asset_number: incomingAssetNumber,
        user_id: req.session.userId || null,
        username: req.session.displayName || req.session.username || null,
        notes: req.body.notes || null
      });

      // Create incoming usage log
      await EquipmentUsageLog.create({
        usage_date: req.body.incoming_date || today,
        management_number: itemCode,
        model_name: req.body.model_name || null,
        ownership: req.body.ownership || 'company',
        status: '입고',
        notes: req.body.notes || null
      });

      await AuditLog.log(req, { action: 'create', targetType: 'module_incoming', targetId: itemCode, targetLabel: '부품입고: ' + itemCode });
    } else {
      // Equipment incoming: create asset record(s)
      const assetNumber = req.body.asset_number || null;
      const nodeCount = parseInt(req.body.node_count) || 1;
      const uSize = parseInt(req.body.u_size) || 1;
      const rackUnitSize = uSize * 3;

      // Auto-generate management_number for vendor equipment
      baseMgmt = req.body.management_number;
      if (req.body.ownership === 'vendor' && !baseMgmt) {
        let vendorName = 'VND';
        if (req.body.new_vendor_name && req.body.new_vendor_name.trim()) {
          vendorName = req.body.new_vendor_name.trim();
        } else if (vendorId) {
          const v = await Vendor.findById(vendorId);
          if (v) vendorName = v.vendor_name;
        }
        baseMgmt = await generateVendorManagementNumber(vendorName);
      }

      // Check if an existing asset with this management_number already exists (re-incoming)
      const existingAsset = baseMgmt ? await Asset.findByManagementNumber(baseMgmt) : null;

      if (existingAsset) {
        // Re-incoming: reactivate existing asset (keep computing modules intact)
        await Asset.reactivate(existingAsset.id);
        // Update rack_unit_size from incoming U size
        if (rackUnitSize > 0) {
          await pool.query('UPDATE assets SET rack_unit_size = $1 WHERE id = $2', [rackUnitSize, existingAsset.id]);
        }

        await EquipmentUsageLog.create({
          usage_date: req.body.incoming_date || today,
          management_number: baseMgmt,
          asset_number: assetNumber || existingAsset.asset_number,
          model_name: req.body.model_name || existingAsset.model_name || null,
          ownership: req.body.ownership || existingAsset.ownership || 'company',
          status: '입고',
          notes: (req.body.notes || '') + ' (재입고)'
        });

        await AuditLog.log(req, { action: 'update', targetType: 'asset_incoming', targetId: existingAsset.id, targetLabel: '재입고: ' + baseMgmt });
      } else if (nodeCount > 1) {
        // Multi-node blade server:
        // 1. Create chassis (parent) asset with base management number
        const chassisId = await Asset.create({
          asset_number: assetNumber,
          management_number: baseMgmt,
          asset_type: assetType,
          ownership: req.body.ownership || 'company',
          vendor_id: vendorId,
          model_name: req.body.model_name || null,
          manufacturer: req.body.manufacturer || null,
          serial_number: req.body.serial_number || null,
          status: req.body.status || 'active',
          purchase_date: req.body.purchase_date || null,
          warranty_end: req.body.warranty_end || null,
          rack_unit_size: rackUnitSize,
          notes: (req.body.notes || '') + (req.body.notes ? ' ' : '') + '(' + nodeCount + '노드 섀시)'
        });

        await EquipmentUsageLog.create({
          usage_date: req.body.incoming_date || today,
          management_number: baseMgmt,
          asset_number: assetNumber,
          model_name: req.body.model_name || null,
          ownership: req.body.ownership || 'company',
          status: '입고',
          notes: nodeCount + '노드 섀시 입고'
        });

        // 2. Create N node assets as children of the chassis
        for (let i = 1; i <= nodeCount; i++) {
          const nodeMgmt = baseMgmt + '-N' + i;

          await Asset.create({
            management_number: nodeMgmt,
            asset_type: assetType,
            ownership: req.body.ownership || 'company',
            vendor_id: vendorId,
            model_name: req.body.model_name || null,
            manufacturer: req.body.manufacturer || null,
            serial_number: null,
            status: req.body.status || 'active',
            purchase_date: req.body.purchase_date || null,
            warranty_end: req.body.warranty_end || null,
            parent_asset_id: chassisId,
            notes: req.body.notes || null
          });

          await EquipmentUsageLog.create({
            usage_date: req.body.incoming_date || today,
            management_number: nodeMgmt,
            model_name: req.body.model_name || null,
            ownership: req.body.ownership || 'company',
            status: '입고',
            notes: baseMgmt + ' 섀시의 노드 ' + i
          });
        }

        await AuditLog.log(req, { action: 'create', targetType: 'asset_incoming', targetId: chassisId, targetLabel: '장비입고(다중노드): ' + baseMgmt + ' (' + nodeCount + '노드)' });
      } else {
        // Single asset (existing behavior)
        const assetId = await Asset.create({
          asset_number: assetNumber,
          management_number: baseMgmt,
          asset_type: assetType,
          ownership: req.body.ownership || 'company',
          vendor_id: vendorId,
          model_name: req.body.model_name || null,
          manufacturer: req.body.manufacturer || null,
          serial_number: req.body.serial_number || null,
          status: req.body.status || 'active',
          purchase_date: req.body.purchase_date || null,
          warranty_end: req.body.warranty_end || null,
          rack_unit_size: rackUnitSize,
          notes: req.body.notes || null
        });

        await EquipmentUsageLog.create({
          usage_date: req.body.incoming_date || today,
          management_number: baseMgmt,
          asset_number: assetNumber,
          model_name: req.body.model_name || null,
          ownership: req.body.ownership || 'company',
          status: '입고',
          notes: req.body.notes || null
        });

        await AuditLog.log(req, { action: 'create', targetType: 'asset_incoming', targetId: assetId, targetLabel: '장비입고: ' + (req.body.management_number || '') });
      }
    }

    // Save uploaded photos
    if (req.files && req.files.length > 0) {
      const uploadedBy = req.session.displayName || req.session.username || null;
      const baseMgmtForPhoto = baseMgmt !== undefined ? baseMgmt : req.body.management_number;
      if (!isModule && baseMgmtForPhoto) {
        const photoAsset = await Asset.findByManagementNumber(baseMgmtForPhoto);
        if (photoAsset) {
          await Photo.bulkCreate('asset', photoAsset.id, req.files, uploadedBy);
        }
      } else if (isModule) {
        // For modules, attach to first asset that uses this item_code, or store as module photo
        const itemCodeForPhoto = itemCode !== undefined ? itemCode : req.body.management_number;
        const { rows: moduleAssetRows } = await pool.query(
          'SELECT asset_id FROM computing_modules WHERE specification = $1 LIMIT 1',
          [itemCodeForPhoto]
        );
        if (moduleAssetRows[0]) {
          await Photo.bulkCreate('asset', moduleAssetRows[0].asset_id, req.files, uploadedBy);
        } else {
          // No asset linked yet — store as module photo with item_code as entity_id
          await Photo.bulkCreate('module', 0, req.files, uploadedBy);
        }
      }
    }

    const nodeCount = parseInt(req.body.node_count) || 1;
    let incomingAssetLink = '';
    const baseMgmtFinal = baseMgmt !== undefined ? baseMgmt : req.body.management_number;
    if (!isModule && baseMgmtFinal) {
      const incomingAsset = await Asset.findByManagementNumber(baseMgmtFinal);
      if (incomingAsset) {
        incomingAssetLink = ' <a href="/assets/' + incomingAsset.id + '">자산 상세 &rarr;</a>';
      }
    }
    const flashMsg = nodeCount > 1 && !isModule
      ? '입고 등록이 완료되었습니다. (' + nodeCount + '개 노드 생성)' + incomingAssetLink
      : '입고 등록이 완료되었습니다.' + incomingAssetLink;
    req.flash('success', flashMsg);
    res.redirect(req.body.returnTo || '/inventory');
  } catch (err) {
    req.flash('error', '입고 등록 실패: ' + err.message);
    res.redirect('/inventory/incoming');
  }
});

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

// EP#10: Create usage — 설계 §5: 이전 in_use 자동반납(returnActiveByManagement append) + 새 in_use INSERT
router.post('/', requireMaintenance, async (req, res) => {
  try {
    const usageAssetType = req.body.usage_asset_type || '';
    const moduleTypeValues = appConfig.moduleTypes.map(t => t.value);
    const isModule = moduleTypeValues.includes(usageAssetType);

    if (isModule) {
      // Module usage registration
      req.body.status = '사용중';
      const id = await EquipmentUsageLog.create({
        usage_date: req.body.usage_date || null,
        management_number: req.body.management_number,
        model_name: req.body.model_name || null,
        ownership: req.body.ownership || 'company',
        user_name: req.body.user_name || null,
        test_name: req.body.test_name || null,
        test_detail: req.body.test_detail || null,
        room: req.body.room || null,
        notes: req.body.notes || null,
        status: '사용중'
      });

      // If target_asset_id is provided, create computing_module link
      const targetAssetId = req.body.target_asset_id;
      if (targetAssetId) {
        await ComputingModule.create({
          asset_id: parseInt(targetAssetId),
          module_type: usageAssetType,
          model: req.body.model_name || null,
          manufacturer: null,
          capacity: null,
          count: 1,
          specification: null,
          slot_info: req.body.module_slot_info || null,
          notes: req.body.management_number || null
        });
      }

      // Recalculate module inventory in-use counts
      await ModuleInventory.recalculateInUse();

      // Log installed event
      const usedItemCode = req.body.management_number;
      if (usedItemCode) {
        const targetAsset = targetAssetId ? await Asset.findById(parseInt(targetAssetId)) : null;
        await ModuleInventoryLog.create({
          item_code: usedItemCode,
          event_type: 'installed',
          asset_id: targetAssetId ? parseInt(targetAssetId) : null,
          asset_label: targetAsset ? (targetAsset.management_number || targetAsset.asset_number || String(targetAssetId)) : null,
          user_id: req.session.userId || null,
          username: req.session.displayName || req.session.username || null,
          notes: req.body.notes || null
        });
      }

      await AuditLog.log(req, { action: 'create', targetType: 'module_usage', targetId: id, targetLabel: '부품사용등록: ' + (req.body.management_number || '') });
    } else {
      // Equipment usage registration
      req.body.status = '사용중';
      // Auto-return existing active usage for the same management_number
      // ★ 설계 §5: returnActiveByManagement는 6a에서 returned 이벤트 append INSERT
      const mgmt = req.body.management_number;
      if (mgmt) {
        const today = new Date().toISOString().split('T')[0];
        await EquipmentUsageLog.returnActiveByManagement(mgmt, today);
      }
      // Map dynamic IP fields to DB columns (6b) — xxx_json은 6a buildSnapshots가 JSONB화
      const ipCols = mapIpsToCols(req.body);
      Object.assign(req.body, ipCols);
      // Map dynamic hardware rows to JSON + legacy columns
      const hwCols = mapHardwareToCols(req.body);
      Object.assign(req.body, hwCols);
      // Map dynamic credential rows to JSON + legacy columns
      const credCols = mapCredsToCols(req.body);
      Object.assign(req.body, credCols);
      const id = await EquipmentUsageLog.create(req.body);

      // Sync asset from usage registration (location, IPs, credentials, user, purpose)
      if (mgmt) {
        try {
          const asset = await Asset.findByManagementNumber(mgmt);
          if (asset) {
            const roomName = req.body.room;
            const rackName = req.body.rack;
            const unitStr = req.body.unit;
            let updateFields = {};

            // Find room_id by name
            if (roomName) {
              const room = (await ServerRoom.findAll()).find(r => r.name === roomName);
              if (room) updateFields.room_id = room.id;
            }

            // Infrastructure types (immersion_tank, cdu, chiller): room only, no rack placement
            const infraAssetTypes = ['immersion_tank', 'cdu', 'chiller'];
            if (infraAssetTypes.includes(asset.asset_type) || infraAssetTypes.includes(usageAssetType)) {
              // Clear rack fields for infrastructure types
              updateFields.rack_id = null;
              updateFields.rack_unit_start = null;

              // For immersion_tank: auto-create or update linked rack
              if (asset.asset_type === 'immersion_tank' || usageAssetType === 'immersion_tank') {
                const tankCapacityU = parseInt(req.body.tank_capacity_u) || 42;
                const switchSlots = parseInt(req.body.switch_slots) || 0;
                const roomId = updateFields.room_id || asset.room_id;

                // Check if a linked rack already exists
                let linkedRack = await Rack.findByLinkedAsset(asset.id);
                if (linkedRack) {
                  // Update existing linked rack
                  await Rack.update(linkedRack.id, {
                    name: linkedRack.name,
                    room_id: roomId || linkedRack.room_id,
                    total_units: tankCapacityU,
                    row_position: linkedRack.row_position,
                    col_position: linkedRack.col_position,
                    description: linkedRack.description,
                    rack_type: 'immersion',
                    switch_slots: switchSlots
                  });
                } else if (roomId) {
                  // Create new linked rack
                  const tankName = (asset.model_name || asset.management_number || '액침탱크') + ' (탱크)';
                  await Rack.create({
                    room_id: roomId,
                    name: tankName,
                    total_units: tankCapacityU,
                    row_position: 1,
                    col_position: 1,
                    description: '자산 ' + (asset.management_number || asset.id) + ' 연결 탱크',
                    rack_type: 'immersion',
                    linked_asset_id: asset.id,
                    switch_slots: switchSlots
                  });
                }
              }

              // For CDU/chiller: link to parent infrastructure asset (tank or CDU)
              const linkedInfraAssetId = parseInt(req.body.linked_infra_asset_id) || null;
              if (linkedInfraAssetId && (asset.asset_type === 'cdu' || asset.asset_type === 'chiller' || usageAssetType === 'cdu' || usageAssetType === 'chiller')) {
                updateFields.parent_asset_id = linkedInfraAssetId;
                // Also sync room from parent if not set
                if (!updateFields.room_id) {
                  const parentInfra = await Asset.findById(linkedInfraAssetId);
                  if (parentInfra && parentInfra.room_id) {
                    updateFields.room_id = parentInfra.room_id;
                  }
                }
              }
            } else {
            // Find rack_id by name (and room)
            if (rackName) {
              const allRacks = await Rack.findAll();
              const rack = allRacks.find(r => r.name === rackName && (!updateFields.room_id || r.room_id === updateFields.room_id))
                        || allRacks.find(r => r.name === rackName);
              if (rack) {
                updateFields.rack_id = rack.id;
                if (!updateFields.room_id) updateFields.room_id = rack.room_id;
              }
            }

            // Switch slot placement (for immersion tank switch slots)
            const switchSlot = (req.body.switch_slot || '').trim();
            if (switchSlot && switchSlot.match(/^SW\d+$/i)) {
              // Place in switch slot instead of U position
              updateFields.blade_slot = switchSlot;
              updateFields.rack_unit_start = null;
              updateFields.rack_unit_size = null;
            } else {
              // Parse unit string to slot
              // Supports: "U5" "U5-U8" "U5H2" "U5H2-U8H1" "U5H2-U8" (H=hole 1~3)
              if (unitStr) {
                const startMatch = unitStr.match(/U(\d+)(?:H(\d))?/i);
                if (startMatch) {
                  const uStart = parseInt(startMatch[1]);
                  const hStart = parseInt(startMatch[2]) || 1;
                  const slotStart = (uStart - 1) * 3 + hStart;
                  updateFields.rack_unit_start = slotStart;

                  // Check for end range: second U marker
                  const endMatch = unitStr.match(/U\d+(?:H\d)?[^U]*U(\d+)(?:H(\d))?/i);
                  if (endMatch) {
                    const uEnd = parseInt(endMatch[1]);
                    const hEnd = parseInt(endMatch[2]) || 3;
                    const slotEnd = (uEnd - 1) * 3 + hEnd;
                    updateFields.rack_unit_size = slotEnd - slotStart + 1;
                  }
                }
              }
            }
            } // end of else (non-infra types)

            // Shelf size (in slots) - stored separately
            const shelfSize = parseInt(req.body.shelf_size) || 0;

            // Sync assigned_user and purpose
            if (req.body.user_name) updateFields.assigned_user = req.body.user_name;
            if (req.body.test_name) {
              const tn = req.body.test_name.trim();
              const td = (req.body.test_detail || '').trim();
              if (td && td !== '-' && td !== tn) {
                updateFields.purpose = tn + '(' + td + ')';
              } else {
                updateFields.purpose = tn;
              }
            }

            if (Object.keys(updateFields).length > 0) {
              await Asset.update(asset.id, { ...asset, ...updateFields });

              // Save shelf_size
              if (shelfSize >= 0) {
                await pool.query('UPDATE assets SET shelf_size = $1 WHERE id = $2', [shelfSize, asset.id]);
              }

              // If this is a node, sync location to parent chassis
              if (asset.parent_asset_id && (updateFields.room_id || updateFields.rack_id || updateFields.rack_unit_start)) {
                const parentAsset = await Asset.findById(asset.parent_asset_id);
                if (parentAsset) {
                  const parentUpdate = { ...parentAsset };
                  if (updateFields.room_id) parentUpdate.room_id = updateFields.room_id;
                  if (updateFields.rack_id) parentUpdate.rack_id = updateFields.rack_id;
                  if (updateFields.rack_unit_start) parentUpdate.rack_unit_start = updateFields.rack_unit_start;
                  if (updateFields.rack_unit_size) parentUpdate.rack_unit_size = updateFields.rack_unit_size;
                  await Asset.update(parentAsset.id, parentUpdate);
                }
              }
            }

            // Sync IPs → asset_ips table
            const purposes = req.body['ip_purposes[]'] || req.body.ip_purposes || [];
            const ipVals = req.body['ip_values[]'] || req.body.ip_values || [];
            const ipIfaceTypes = req.body['ip_iface_types[]'] || req.body.ip_iface_types || [];
            const ipSpeeds = req.body['ip_speeds[]'] || req.body.ip_speeds || [];
            const pArr = Array.isArray(purposes) ? purposes : [purposes];
            const vArr = Array.isArray(ipVals) ? ipVals : [ipVals];
            const ifArr = Array.isArray(ipIfaceTypes) ? ipIfaceTypes : [ipIfaceTypes];
            const spArr = Array.isArray(ipSpeeds) ? ipSpeeds : [ipSpeeds];
            const assetIps = [];
            for (let i = 0; i < pArr.length; i++) {
              const purpose = normalizePurpose(pArr[i]);
              const addr = (vArr[i] || '').trim();
              if (!addr) continue;
              let ipType = purpose;
              let desc = '';
              if (!['management', 'bmc', 'ib', 'data', 'os', 'other'].includes(ipType)) {
                desc = purpose; // 커스텀 용도를 설명에 보존
                ipType = 'other';
              }
              assetIps.push({ ip_address: addr, ip_type: ipType, description: desc, interface_type: (ifArr[i] || '').trim(), speed: (spArr[i] || '').trim() });
            }
            if (assetIps.length > 0) {
              await AssetIp.deleteByAsset(asset.id);
              await AssetIp.bulkCreate(asset.id, assetIps);
              await IpAddress.syncAssetIps(asset.id, assetIps.map(ip => ip.ip_address));
            }

            // Sync credentials → asset_credentials table
            const credTypes = req.body['cred_types[]'] || req.body.cred_types || [];
            const credUsers = req.body['cred_usernames[]'] || req.body.cred_usernames || [];
            const credPwds = req.body['cred_passwords[]'] || req.body.cred_passwords || [];
            const ctArr = Array.isArray(credTypes) ? credTypes : [credTypes];
            const cuArr = Array.isArray(credUsers) ? credUsers : [credUsers];
            const cpArr = Array.isArray(credPwds) ? credPwds : [credPwds];
            const assetCreds = [];
            for (let i = 0; i < ctArr.length; i++) {
              const cType = (ctArr[i] || '').trim();
              const username = (cuArr[i] || '').trim();
              const password = (cpArr[i] || '').trim();
              if (!cType || !username) continue;
              let credType = 'root';
              if (cType === 'root') credType = 'root';
              else if (cType === 'bmc') credType = 'bmc';
              else credType = 'user';
              assetCreds.push({ username, password, credential_type: credType, description: cType });
            }
            if (assetCreds.length > 0) {
              await AssetCredential.deleteByAsset(asset.id);
              await AssetCredential.bulkCreate(asset.id, assetCreds);
            }
          }
        } catch (syncErr) {
          console.error('자산 동기화 오류:', syncErr);
        }
      }

      await AuditLog.log(req, { action: 'create', targetType: 'equipment_usage', targetId: id, targetLabel: '사용등록: ' + (req.body.management_number || '') });
    }

    req.flash('success', '사용 등록이 완료되었습니다.');
    res.redirect(req.body.returnTo || '/inventory');
  } catch (err) {
    req.flash('error', '등록 실패: ' + err.message);
    res.redirect('/inventory/new');
  }
});

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
