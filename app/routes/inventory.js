const express = require('express');
const router = express.Router();
const EquipmentUsageLog = require('../models/equipmentUsageLog');
const ModuleInventory = require('../models/moduleInventory');
const ServerRoom = require('../models/serverRoom');
const Rack = require('../models/rack');
const Asset = require('../models/asset');
const AssetIp = require('../models/assetIp');
const AssetCredential = require('../models/assetCredential');
const Vendor = require('../models/vendor');
const ComputingModule = require('../models/computingModule');
const appConfig = require('../config/app');
const { requireMaintenance } = require('../middleware/auth');
const AuditLog = require('../models/auditLog');
const { getDb } = require('../config/database');

// Helper: generate vendor management number based on vendor name (업체명-NNN)
function generateVendorManagementNumber(vendorName) {
  const name = (vendorName || 'VND').trim();
  const prefix = name + '-';
  const row = getDb().prepare(
    "SELECT management_number FROM assets WHERE management_number LIKE ? ORDER BY management_number DESC LIMIT 1"
  ).get(prefix + '%');
  let seq = 1;
  if (row) {
    const suffix = row.management_number.substring(prefix.length);
    const last = parseInt(suffix);
    if (!isNaN(last)) seq = last + 1;
  }
  return prefix + String(seq).padStart(3, '0');
}

// Helper: parse dynamic hardware rows into hardware_json + legacy columns
function mapHardwareToCols(body) {
  const types = body['hw_types[]'] || body.hw_types || [];
  const codes = body['hw_codes[]'] || body.hw_codes || [];
  const nums = body['hw_nums[]'] || body.hw_nums || [];
  const tArr = Array.isArray(types) ? types : [types];
  const cArr = Array.isArray(codes) ? codes : [codes];
  const nArr = Array.isArray(nums) ? nums : [nums];

  const items = [];
  for (let i = 0; i < tArr.length; i++) {
    const t = (tArr[i] || '').trim();
    const c = (cArr[i] || '').trim();
    const n = parseInt(nArr[i]) || 0;
    if (t && (c || n > 0)) {
      items.push({ type: t, code: c, num: n });
    }
  }

  const result = {
    hardware_json: items.length > 0 ? JSON.stringify(items) : null,
    cpu_type: null, cpu_num: null,
    mem1_type: null, mem1_num: null, mem2_type: null, mem2_num: null,
    disk1_part: null, disk1_num: null, disk2_part: null, disk2_num: null,
    disk3_part: null, disk3_num: null, disk4_part: null, disk4_num: null,
    nic1_type: null, nic1_num: null, nic2_type: null, nic2_num: null,
    nic3_type: null, nic3_num: null, nic4_type: null, nic4_num: null,
    raid_type: null, raid_num: null,
    gpu1_type: null, gpu1_num: null, gpu2_type: null, gpu2_num: null
  };

  // Map to legacy columns for backward compatibility
  let cpuIdx = 0, memIdx = 0, diskIdx = 0, nicIdx = 0, raidIdx = 0, gpuIdx = 0;
  items.forEach(item => {
    switch (item.type) {
      case 'cpu':
        if (cpuIdx === 0) { result.cpu_type = item.code; result.cpu_num = item.num; }
        cpuIdx++;
        break;
      case 'memory':
        if (memIdx === 0) { result.mem1_type = item.code; result.mem1_num = item.num; }
        else if (memIdx === 1) { result.mem2_type = item.code; result.mem2_num = item.num; }
        memIdx++;
        break;
      case 'disk':
        if (diskIdx === 0) { result.disk1_part = item.code; result.disk1_num = item.num; }
        else if (diskIdx === 1) { result.disk2_part = item.code; result.disk2_num = item.num; }
        else if (diskIdx === 2) { result.disk3_part = item.code; result.disk3_num = item.num; }
        else if (diskIdx === 3) { result.disk4_part = item.code; result.disk4_num = item.num; }
        diskIdx++;
        break;
      case 'network':
        if (nicIdx === 0) { result.nic1_type = item.code; result.nic1_num = item.num; }
        else if (nicIdx === 1) { result.nic2_type = item.code; result.nic2_num = item.num; }
        else if (nicIdx === 2) { result.nic3_type = item.code; result.nic3_num = item.num; }
        else if (nicIdx === 3) { result.nic4_type = item.code; result.nic4_num = item.num; }
        nicIdx++;
        break;
      case 'raid':
        if (raidIdx === 0) { result.raid_type = item.code; result.raid_num = item.num; }
        raidIdx++;
        break;
      case 'gpu':
        if (gpuIdx === 0) { result.gpu1_type = item.code; result.gpu1_num = item.num; }
        else if (gpuIdx === 1) { result.gpu2_type = item.code; result.gpu2_num = item.num; }
        gpuIdx++;
        break;
    }
  });

  return result;
}

// Helper: map dynamic IP arrays to DB columns
// Build label→value reverse map for IP purpose (case-insensitive)
const ipLabelToValue = {};
appConfig.ipTypes.forEach(t => {
  ipLabelToValue[t.label.toLowerCase()] = t.value;
  ipLabelToValue[t.value.toLowerCase()] = t.value;
});

function normalizePurpose(raw) {
  const key = (raw || '').trim().toLowerCase();
  return ipLabelToValue[key] || raw.trim();
}

function mapIpsToCols(body) {
  const purposes = body['ip_purposes[]'] || body.ip_purposes || [];
  const values = body['ip_values[]'] || body.ip_values || [];
  const pArr = Array.isArray(purposes) ? purposes : [purposes];
  const vArr = Array.isArray(values) ? values : [values];

  const result = { ip1: null, ip2: null, ip3: null, ip4: null, bmc: null, ib1: null, ib2: null, ips_json: null };
  let mgmtIdx = 0, ibIdx = 0;
  const ipsItems = [];

  for (let i = 0; i < pArr.length; i++) {
    const purpose = normalizePurpose(pArr[i]);
    const val = (vArr[i] || '').trim();
    if (!val) continue;
    ipsItems.push({ purpose, ip: val });
    if (purpose === 'bmc') {
      result.bmc = val;
    } else if (purpose === 'ib') {
      if (ibIdx === 0) { result.ib1 = val; ibIdx++; }
      else if (ibIdx === 1) { result.ib2 = val; ibIdx++; }
    } else {
      if (mgmtIdx === 0) { result.ip1 = val; mgmtIdx++; }
      else if (mgmtIdx === 1) { result.ip2 = val; mgmtIdx++; }
      else if (mgmtIdx === 2) { result.ip3 = val; mgmtIdx++; }
      else if (mgmtIdx === 3) { result.ip4 = val; mgmtIdx++; }
    }
  }
  result.ips_json = ipsItems.length > 0 ? JSON.stringify(ipsItems) : null;
  return result;
}

// Helper: map dynamic credential arrays to JSON + legacy columns
function mapCredsToCols(body) {
  const types = body['cred_types[]'] || body.cred_types || [];
  const usernames = body['cred_usernames[]'] || body.cred_usernames || [];
  const passwords = body['cred_passwords[]'] || body.cred_passwords || [];
  const tArr = Array.isArray(types) ? types : [types];
  const uArr = Array.isArray(usernames) ? usernames : [usernames];
  const pArr = Array.isArray(passwords) ? passwords : [passwords];

  const items = [];
  for (let i = 0; i < tArr.length; i++) {
    const t = (tArr[i] || '').trim();
    const u = (uArr[i] || '').trim();
    const p = (pArr[i] || '').trim();
    if (t && (u || p)) {
      items.push({ type: t, username: u, password: p });
    }
  }

  const result = {
    credentials_json: items.length > 0 ? JSON.stringify(items) : null,
    credential_root: null, credential_etc1: null, credential_etc2: null
  };

  // Map to legacy columns for backward compatibility
  let etcIdx = 0;
  for (const item of items) {
    const pair = item.username + ' / ' + item.password;
    if (item.type === 'root' && !result.credential_root) {
      result.credential_root = pair;
    } else {
      if (etcIdx === 0) { result.credential_etc1 = pair; etcIdx++; }
      else if (etcIdx === 1) { result.credential_etc2 = pair; etcIdx++; }
    }
  }
  return result;
}

// Inventory list
router.get('/', (req, res) => {
  const filters = {
    status: req.query.status,
    room: req.query.room,
    user_name: req.query.user_name,
    ownership: req.query.ownership,
    date_from: req.query.date_from,
    date_to: req.query.date_to,
    search: req.query.search
  };
  const logs = EquipmentUsageLog.findAll(filters);
  const counts = EquipmentUsageLog.countByStatus();
  const rooms = EquipmentUsageLog.getRooms();
  const users = EquipmentUsageLog.getUsers();

  res.render('inventory/index', {
    title: '입출고 관리',
    currentPath: '/inventory',
    extraCss: null,
    extraJs: null,
    logs,
    counts,
    rooms,
    users,
    filters,
    appConfig
  });
});

// === Incoming Registration (입고 등록) ===

// GET /incoming - incoming registration form
router.get('/incoming', (req, res) => {
  const vendors = Vendor.findAll();
  const moduleInventoryItems = ModuleInventory.findAll();

  res.render('inventory/incoming-form', {
    title: '입고 등록',
    currentPath: '/inventory',
    extraCss: null,
    extraJs: null,
    vendors,
    moduleInventoryItems,
    appConfig
  });
});

// POST /incoming - create incoming record
router.post('/incoming', requireMaintenance, (req, res) => {
  try {
    const assetType = req.body.asset_type;
    const moduleTypeValues = appConfig.moduleTypes.map(t => t.value);
    const isModule = moduleTypeValues.includes(assetType);
    const today = new Date().toISOString().split('T')[0];

    // Handle new vendor creation
    let vendorId = req.body.vendor_id || null;
    if (vendorId === '__new__' && req.body.new_vendor_name) {
      vendorId = Vendor.create({ vendor_name: req.body.new_vendor_name });
    } else if (vendorId === '__new__') {
      vendorId = null;
    }

    if (isModule) {
      // Module incoming: upsert into module_inventory
      const itemCode = req.body.management_number;
      const quantity = parseInt(req.body.quantity) || 1;

      // Check if existing
      const existing = ModuleInventory.findByCode(itemCode);
      if (existing) {
        // Increase total and spare quantities
        ModuleInventory.upsert({
          module_type: assetType,
          item_code: itemCode,
          label: existing.label,
          manufacturer: req.body.manufacturer || existing.manufacturer,
          model: req.body.model_name || existing.model,
          capacity: req.body.capacity || existing.capacity,
          specification: req.body.specification || existing.specification,
          total_quantity: existing.total_quantity + quantity,
          in_use_quantity: existing.in_use_quantity,
          spare_quantity: existing.spare_quantity + quantity
        });
      } else {
        // New module inventory entry
        ModuleInventory.upsert({
          module_type: assetType,
          item_code: itemCode,
          label: req.body.model_name || itemCode,
          manufacturer: req.body.manufacturer || null,
          model: req.body.model_name || null,
          capacity: req.body.capacity || null,
          specification: req.body.specification || null,
          total_quantity: quantity,
          in_use_quantity: 0,
          spare_quantity: quantity
        });
      }

      // Create incoming usage log
      EquipmentUsageLog.create({
        usage_date: req.body.incoming_date || today,
        management_number: itemCode,
        model_name: req.body.model_name || null,
        ownership: req.body.ownership || 'company',
        status: '입고',
        notes: req.body.notes || null
      });

      AuditLog.log(req, { action: 'create', targetType: 'module_incoming', targetId: itemCode, targetLabel: '부품입고: ' + itemCode });
    } else {
      // Equipment incoming: create asset record
      const assetNumber = req.body.asset_number || null;

      // Auto-generate management_number for vendor equipment
      let managementNumber = req.body.management_number;
      if (req.body.ownership === 'vendor' && !managementNumber) {
        let vendorName = 'VND';
        if (req.body.new_vendor_name && req.body.new_vendor_name.trim()) {
          vendorName = req.body.new_vendor_name.trim();
        } else if (vendorId) {
          const v = Vendor.findById(vendorId);
          if (v) vendorName = v.vendor_name;
        }
        managementNumber = generateVendorManagementNumber(vendorName);
      }

      const assetId = Asset.create({
        asset_number: assetNumber,
        management_number: managementNumber,
        asset_type: assetType,
        ownership: req.body.ownership || 'company',
        vendor_id: vendorId,
        model_name: req.body.model_name || null,
        manufacturer: req.body.manufacturer || null,
        serial_number: req.body.serial_number || null,
        status: req.body.status || 'active',
        purchase_date: req.body.purchase_date || null,
        warranty_end: req.body.warranty_end || null,
        notes: req.body.notes || null
      });

      // Create incoming usage log
      EquipmentUsageLog.create({
        usage_date: req.body.incoming_date || today,
        management_number: managementNumber,
        asset_number: assetNumber,
        model_name: req.body.model_name || null,
        ownership: req.body.ownership || 'company',
        status: '입고',
        notes: req.body.notes || null
      });

      AuditLog.log(req, { action: 'create', targetType: 'asset_incoming', targetId: assetId, targetLabel: '장비입고: ' + (req.body.management_number || '') });
    }

    req.flash('success', '입고 등록이 완료되었습니다.');
    res.redirect('/inventory');
  } catch (err) {
    req.flash('error', '입고 등록 실패: ' + err.message);
    res.redirect('/inventory/incoming');
  }
});

// API: get next vendor management number (for preview)
router.get('/api/vendor-mgmt-number', (req, res) => {
  try {
    let vendorName = 'VND';
    if (req.query.vendor_name) {
      vendorName = req.query.vendor_name.trim();
    } else if (req.query.vendor_id) {
      const v = Vendor.findById(req.query.vendor_id);
      if (v) vendorName = v.vendor_name;
    }
    res.json({ management_number: generateVendorManagementNumber(vendorName) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: get next management number suggestions by asset type
router.get('/api/next-mgmt-number', (req, res) => {
  try {
    const assetType = req.query.asset_type;
    if (!assetType) return res.json({ suggestions: [], recent: [] });

    const rows = getDb().prepare(
      "SELECT management_number FROM assets WHERE asset_type = ? AND management_number IS NOT NULL AND management_number != ''"
    ).all(assetType);

    // Group by prefix: split management_number into prefix + trailing number
    const prefixMap = {}; // prefix -> { numbers: [], count }
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
    const recentRows = getDb().prepare(
      "SELECT management_number FROM assets WHERE asset_type = ? AND management_number IS NOT NULL AND management_number != '' ORDER BY id DESC LIMIT 5"
    ).all(assetType);
    const recent = recentRows.map(r => r.management_number);

    res.json({ suggestions, recent });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: check if management number already exists
router.get('/api/check-mgmt-number', (req, res) => {
  try {
    const mgmtNumber = req.query.management_number;
    if (!mgmtNumber) return res.json({ exists: false });

    const row = getDb().prepare(
      "SELECT COUNT(*) as cnt FROM assets WHERE management_number = ?"
    ).get(mgmtNumber);
    res.json({ exists: row.cnt > 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: get module inventory items by type (for AJAX)
router.get('/api/modules/:type', (req, res) => {
  try {
    const items = ModuleInventory.findAll(req.params.type);
    res.json(items);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// New usage registration form
router.get('/new', (req, res) => {
  const mgmt = req.query.mgmt;
  let prefill = null;
  if (mgmt) {
    prefill = EquipmentUsageLog.getLatestByManagement(mgmt);
  }

  const componentTypes = ModuleInventory.findAll();
  const serverRooms = ServerRoom.findAll();
  const racks = Rack.findAll();
  const assets = Asset.findAll();
  const moduleInventoryItems = ModuleInventory.findAll();

  res.render('inventory/form', {
    title: '사용 등록',
    currentPath: '/inventory',
    extraCss: null,
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
});

// Create usage
router.post('/', requireMaintenance, (req, res) => {
  try {
    const usageAssetType = req.body.usage_asset_type || '';
    const moduleTypeValues = appConfig.moduleTypes.map(t => t.value);
    const isModule = moduleTypeValues.includes(usageAssetType);

    if (isModule) {
      // Module usage registration
      req.body.status = '사용중';
      const id = EquipmentUsageLog.create({
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
        ComputingModule.create({
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
      ModuleInventory.recalculateInUse();

      AuditLog.log(req, { action: 'create', targetType: 'module_usage', targetId: id, targetLabel: '부품사용등록: ' + (req.body.management_number || '') });
    } else {
      // Equipment usage registration (existing logic)
      req.body.status = '사용중';
      // Auto-return existing active usage for the same management_number
      const mgmt = req.body.management_number;
      if (mgmt) {
        const today = new Date().toISOString().split('T')[0];
        EquipmentUsageLog.returnActiveByManagement(mgmt, today);
      }
      // Map dynamic IP fields to DB columns
      const ipCols = mapIpsToCols(req.body);
      Object.assign(req.body, ipCols);
      // Map dynamic hardware rows to JSON + legacy columns
      const hwCols = mapHardwareToCols(req.body);
      Object.assign(req.body, hwCols);
      // Map dynamic credential rows to JSON + legacy columns
      const credCols = mapCredsToCols(req.body);
      Object.assign(req.body, credCols);
      const id = EquipmentUsageLog.create(req.body);

      // Sync asset from usage registration (location, IPs, credentials, user, purpose)
      if (mgmt) {
        try {
          const assetList = Asset.findAll();
          const assetMatch = assetList.find(a => a.management_number === mgmt);
          const asset = assetMatch ? Asset.findById(assetMatch.id) : null;
          if (asset) {
            const roomName = req.body.room;
            const rackName = req.body.rack;
            const unitStr = req.body.unit;
            let updateFields = {};

            // Find room_id by name
            if (roomName) {
              const room = ServerRoom.findAll().find(r => r.name === roomName);
              if (room) updateFields.room_id = room.id;
            }

            // Find rack_id by name (and room)
            if (rackName) {
              const allRacks = Rack.findAll();
              const rack = allRacks.find(r => r.name === rackName && (!updateFields.room_id || r.room_id === updateFields.room_id))
                        || allRacks.find(r => r.name === rackName);
              if (rack) {
                updateFields.rack_id = rack.id;
                if (!updateFields.room_id) updateFields.room_id = rack.room_id;
              }
            }

            // Parse unit string (e.g. "U25-U27" or "U25") to slot
            if (unitStr) {
              const uMatch = unitStr.match(/U(\d+)/i);
              if (uMatch) {
                const uStart = parseInt(uMatch[1]);
                const slotStart = (uStart - 1) * 3 + 1;
                updateFields.rack_unit_start = slotStart;

                const uEndMatch = unitStr.match(/U\d+.*?U(\d+)/i);
                if (uEndMatch) {
                  const uEnd = parseInt(uEndMatch[1]);
                  updateFields.rack_unit_size = (uEnd - uStart + 1) * 3;
                }
              }
            }

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
              Asset.update(asset.id, { ...asset, ...updateFields });
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
              if (!['management','bmc','ib','data','os','other'].includes(ipType)) {
                desc = purpose; // 커스텀 용도를 설명에 보존
                ipType = 'other';
              }
              assetIps.push({ ip_address: addr, ip_type: ipType, description: desc, interface_type: (ifArr[i] || '').trim(), speed: (spArr[i] || '').trim() });
            }
            if (assetIps.length > 0) {
              AssetIp.deleteByAsset(asset.id);
              AssetIp.bulkCreate(asset.id, assetIps);
              const IpAddress = require('../models/ipAddress');
              IpAddress.syncAssetIps(asset.id, assetIps.map(ip => ip.ip_address));
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
              AssetCredential.deleteByAsset(asset.id);
              AssetCredential.bulkCreate(asset.id, assetCreds);
            }
          }
        } catch (syncErr) {
          console.error('자산 동기화 오류:', syncErr);
        }
      }

      AuditLog.log(req, { action: 'create', targetType: 'equipment_usage', targetId: id, targetLabel: '사용등록: ' + (req.body.management_number || '') });
    }

    req.flash('success', '사용 등록이 완료되었습니다.');
    res.redirect('/inventory');
  } catch (err) {
    req.flash('error', '등록 실패: ' + err.message);
    res.redirect('/inventory/new');
  }
});

// Equipment detail by management number
router.get('/equipment/:mgmt', (req, res) => {
  const mgmt = req.params.mgmt;
  const history = EquipmentUsageLog.getHistory(mgmt);
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
      hwItems.forEach(h => {
        if (h.code && h.code !== '-' && !componentSpecs[h.code]) {
          const spec = ModuleInventory.findByCode(h.code);
          if (spec) componentSpecs[h.code] = spec;
        }
      });
    } catch(e) {}
  }
  // Also check legacy columns
  const compFields = [
    'cpu_type', 'mem1_type', 'mem2_type',
    'disk1_part', 'disk2_part', 'disk3_part', 'disk4_part',
    'nic1_type', 'nic2_type', 'nic3_type', 'nic4_type',
    'raid_type', 'gpu1_type', 'gpu2_type'
  ];
  compFields.forEach(f => {
    const code = latest[f];
    if (code && code !== '-' && !componentSpecs[code]) {
      const spec = ModuleInventory.findByCode(code);
      if (spec) componentSpecs[code] = spec;
    }
  });

  res.render('inventory/equipment-detail', {
    title: mgmt + ' 장비 상세',
    currentPath: '/inventory',
    extraCss: null,
    extraJs: null,
    mgmt,
    latest,
    history,
    componentSpecs,
    appConfig
  });
});

// Edit form
router.get('/:id/edit', (req, res) => {
  const log = EquipmentUsageLog.findById(req.params.id);
  if (!log) {
    req.flash('error', '기록을 찾을 수 없습니다.');
    return res.redirect('/inventory');
  }
  const componentTypes = ModuleInventory.findAll();
  const serverRooms = ServerRoom.findAll();
  const racks = Rack.findAll();
  const assets = Asset.findAll();
  const moduleInventoryItems = ModuleInventory.findAll();

  res.render('inventory/form', {
    title: '수정',
    currentPath: '/inventory',
    extraCss: null,
    extraJs: null,
    log,
    isEdit: true,
    componentTypes,
    serverRooms,
    racks,
    assets,
    moduleInventoryItems,
    appConfig,
    returnTo: req.query.returnTo || req.get('Referer') || ''
  });
});

// Update
router.post('/:id', requireMaintenance, (req, res) => {
  try {
    // Map dynamic IP fields to DB columns
    const ipCols = mapIpsToCols(req.body);
    Object.assign(req.body, ipCols);
    // Map dynamic hardware rows to JSON + legacy columns
    const hwCols = mapHardwareToCols(req.body);
    Object.assign(req.body, hwCols);
    // Map dynamic credential rows to JSON + legacy columns
    const credCols = mapCredsToCols(req.body);
    Object.assign(req.body, credCols);
    EquipmentUsageLog.update(req.params.id, req.body);
    AuditLog.log(req, { action: 'update', targetType: 'equipment_usage', targetId: req.params.id, targetLabel: req.body.management_number || '' });
    req.flash('success', '수정이 완료되었습니다.');
    const returnTo = req.body.returnTo;
    res.redirect(returnTo || '/inventory');
  } catch (err) {
    req.flash('error', '수정 실패: ' + err.message);
    res.redirect('/inventory/' + req.params.id + '/edit');
  }
});

// Return (반납)
router.post('/:id/return', requireMaintenance, (req, res) => {
  try {
    const returnDate = req.body.return_date || new Date().toISOString().split('T')[0];
    EquipmentUsageLog.markReturned(req.params.id, returnDate);
    AuditLog.log(req, { action: 'update', targetType: 'equipment_usage', targetId: req.params.id, targetLabel: '반납처리' });
    req.flash('success', '반납 처리가 완료되었습니다.');
  } catch (err) {
    req.flash('error', '반납 실패: ' + err.message);
  }
  res.redirect(req.body.returnTo || req.get('Referer') || '/inventory');
});

// Delete
router.post('/:id/delete', requireMaintenance, (req, res) => {
  try {
    EquipmentUsageLog.delete(req.params.id);
    AuditLog.log(req, { action: 'delete', targetType: 'equipment_usage', targetId: req.params.id });
    req.flash('success', '기록이 삭제되었습니다.');
  } catch (err) {
    req.flash('error', '삭제 실패: ' + err.message);
  }
  res.redirect(req.body.returnTo || req.get('Referer') || '/inventory');
});

// Asset detail API (AJAX for auto-fill)
router.get('/api/asset/:id', (req, res) => {
  try {
    const asset = Asset.findById(req.params.id);
    if (!asset) return res.status(404).json({ error: 'Not found' });
    const ips = AssetIp.findByAsset(req.params.id);
    const credentials = AssetCredential.findByAsset(req.params.id);
    res.json({ asset, ips, credentials });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Component spec API (AJAX)
router.get('/api/component/:code', (req, res) => {
  const spec = ModuleInventory.findByCode(req.params.code);
  if (!spec) return res.status(404).json({ error: 'Not found' });
  res.json(spec);
});

module.exports = router;
