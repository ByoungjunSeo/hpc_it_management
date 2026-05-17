/**
 * Import script: servers_v2.xlsx → SQLite DB
 * - TTA용 서버 및 PC 현황 (company assets)
 * - 업체용 서버 현황 (vendor assets)
 * - Computing modules from both sheets
 * - Server rooms & racks auto-created as needed
 * - Multi-IP (asset_ips) and multi-credential (asset_credentials) support
 * - 대여(TTA→외부) / 대여(외부→TTA) → lendings + lending_items
 * - 판교IP 사용현황 → ip_addresses sync
 * - 장비부속재료현황(세부) → module_inventory
 * - 입출고관리 → inventory_logs
 */
const XLSX = require('xlsx');
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'it_assets.db');
const EXCEL_PATH = path.join(__dirname, '..', 'servers_v2.xlsx');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const wb = XLSX.readFile(EXCEL_PATH);

// ============================================================
// Ensure all tables exist (in case schema hasn't been updated yet)
// ============================================================
db.exec(`
  CREATE TABLE IF NOT EXISTS asset_ips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_id INTEGER NOT NULL,
    ip_address TEXT NOT NULL,
    ip_type TEXT NOT NULL DEFAULT 'management'
      CHECK(ip_type IN ('management','bmc','ib','data')),
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS asset_credentials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_id INTEGER NOT NULL,
    username TEXT NOT NULL,
    password TEXT,
    credential_type TEXT NOT NULL DEFAULT 'root'
      CHECK(credential_type IN ('root','user','bmc')),
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS lendings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    direction TEXT NOT NULL CHECK(direction IN ('outbound','inbound')),
    counterparty TEXT NOT NULL,
    loan_date DATE,
    return_date DATE,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','returned')),
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS lending_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lending_id INTEGER NOT NULL,
    item_type TEXT NOT NULL,
    item_code TEXT,
    quantity INTEGER DEFAULT 1,
    description TEXT,
    FOREIGN KEY (lending_id) REFERENCES lendings(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS module_inventory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    module_type TEXT NOT NULL,
    item_code TEXT UNIQUE,
    label TEXT,
    manufacturer TEXT,
    model TEXT,
    capacity TEXT,
    specification TEXT,
    total_quantity INTEGER DEFAULT 0,
    in_use_quantity INTEGER DEFAULT 0,
    spare_quantity INTEGER DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_asset_ips_asset ON asset_ips(asset_id);
  CREATE INDEX IF NOT EXISTS idx_asset_credentials_asset ON asset_credentials(asset_id);
  CREATE INDEX IF NOT EXISTS idx_lendings_status ON lendings(status);
  CREATE INDEX IF NOT EXISTS idx_lending_items_lending ON lending_items(lending_id);
  CREATE INDEX IF NOT EXISTS idx_module_inventory_type ON module_inventory(module_type);
`);

// Ensure location_type column exists
const columns = db.prepare("PRAGMA table_info(server_rooms)").all();
const hasLocationType = columns.some(c => c.name === 'location_type');
if (!hasLocationType) {
  db.exec("ALTER TABLE server_rooms ADD COLUMN location_type TEXT DEFAULT 'server_room'");
}

// ============================================================
// Reference data from 장비부속재료현황(세부)
// ============================================================
const refSheet = XLSX.utils.sheet_to_json(wb.Sheets['장비부속재료현황(세부)'], { header: 1, defval: '' });

// Build lookup maps for component type codes
const cpuRef = {};   // CPU-A -> { manufacturer, model, capacity }
const memRef = {};   // mem-16-A -> { manufacturer, model, capacity, spec }
const diskRef = {};  // sto-300G-A -> { manufacturer, model, capacity }
const netRef = {};   // net-10-D -> { manufacturer, model, capacity }
const raidRef = {};  // raid-A -> { manufacturer, model }
const gpuRef = {};   // GPU-16G-A -> { manufacturer, model, capacity }

for (let i = 0; i < refSheet.length; i++) {
  const r = refSheet[i];
  const key = String(r[0] || '').trim();
  if (!key || key === '타입명' || key.includes('재고') || key.includes('용도')) continue;

  if (key.startsWith('mem-')) {
    memRef[key] = { manufacturer: r[2], model: r[4] || r[1], capacity: r[3], spec: `${r[6]} ${r[5]} ${r[8]}`.trim() };
  } else if (key.startsWith('net-')) {
    netRef[key] = { manufacturer: r[3], model: r[4], capacity: r[9] };
  } else if (key.startsWith('sto-')) {
    diskRef[key] = { manufacturer: r[1], model: r[2], capacity: r[6] };
  } else if (key.startsWith('raid-')) {
    raidRef[key] = { manufacturer: r[1], model: r[2] };
  }
}
// CPU section starts around row 100
for (let i = 99; i < refSheet.length; i++) {
  const r = refSheet[i];
  const key = String(r[0] || '').trim();
  if (key.startsWith('CPU-')) {
    cpuRef[key] = { manufacturer: r[1], model: r[2], capacity: `${r[4]}C/${r[5]}T ${r[6]}` };
  }
  if (key.startsWith('GPU-')) {
    gpuRef[key] = { manufacturer: r[1], model: r[2], capacity: r[3] };
  }
}
// GPU section
for (let i = 117; i < refSheet.length; i++) {
  const r = refSheet[i];
  const key = String(r[0] || '').trim();
  if (key.startsWith('GPU-')) {
    gpuRef[key] = { manufacturer: r[1], model: r[2], capacity: r[3] };
  }
}

// ============================================================
// Helper: get or create server room (with location_type)
// ============================================================
const roomCache = {};
function getOrCreateRoom(roomName) {
  if (!roomName || roomName === '-' || roomName === '') return null;

  // Normalize room names
  let normalized = roomName.trim();
  let locationType = 'server_room';

  if (normalized.includes('서버실')) { normalized = 'HPC'; locationType = 'server_room'; }
  else if (normalized.includes('친환경') || normalized.includes('AIDC')) { normalized = 'AIDC'; locationType = 'server_room'; }
  else if (normalized.includes('독립개발실') || normalized.includes('독립') || normalized === '독3') { normalized = '독립개발실3'; locationType = 'office'; }
  else if (normalized.includes('mec') || normalized.includes('MEC')) { normalized = 'AIDC'; locationType = 'server_room'; }
  else if (normalized.includes('장비실')) { normalized = '장비실'; locationType = 'storage'; }
  else if (normalized.includes('판교 사무실') || normalized.includes('사무실')) { normalized = '판교 사무실'; locationType = 'office'; }
  else if (normalized.includes('AI캠퍼스') || normalized.includes('야탑')) { normalized = 'AI캠퍼스(야탑)'; locationType = 'office'; }
  else if (normalized.includes('오픈랩')) { normalized = '오픈랩'; locationType = 'office'; }

  if (roomCache[normalized]) return roomCache[normalized];

  let room = db.prepare('SELECT id FROM server_rooms WHERE name = ?').get(normalized);
  if (!room) {
    const result = db.prepare('INSERT INTO server_rooms (name, location_type) VALUES (?, ?)').run(normalized, locationType);
    room = { id: result.lastInsertRowid };
  } else {
    // Update location_type if it was missing
    db.prepare('UPDATE server_rooms SET location_type = ? WHERE id = ? AND (location_type IS NULL OR location_type = ?)').run(locationType, room.id, 'server_room');
  }
  roomCache[normalized] = room.id;
  return room.id;
}

// ============================================================
// Helper: get or create rack
// ============================================================
const rackCache = {};
function getOrCreateRack(roomId, rackName) {
  if (!roomId || !rackName || rackName === '-' || rackName === '') return null;

  let normalized = rackName.trim();
  // Normalize common variations
  normalized = normalized.replace(/Rack/i, 'Rack').replace(/RACK/, 'Rack');

  const cacheKey = `${roomId}:${normalized}`;
  if (rackCache[cacheKey]) return rackCache[cacheKey];

  let rack = db.prepare('SELECT id FROM racks WHERE room_id = ? AND name = ?').get(roomId, normalized);
  if (!rack) {
    const result = db.prepare('INSERT INTO racks (room_id, name, total_units) VALUES (?, ?, 42)').run(roomId, normalized);
    rack = { id: result.lastInsertRowid };
  }
  rackCache[cacheKey] = rack.id;
  return rack.id;
}

// ============================================================
// Helper: parse unit string like "3", "15, 16", "2,3,4,5", "1 ~ 18"
// ============================================================
function parseUnit(unitStr) {
  if (!unitStr || unitStr === '-' || unitStr === '') return { start: null, size: 1 };
  const s = String(unitStr).trim();

  // "1 ~ 18"
  if (s.includes('~')) {
    const parts = s.split('~').map(x => parseInt(x.trim()));
    if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
      return { start: parts[0], size: parts[1] - parts[0] + 1 };
    }
  }

  // "15, 16" or "2,3,4,5"
  const nums = s.split(/[,\s]+/).map(x => parseInt(x.trim())).filter(x => !isNaN(x));
  if (nums.length === 0) return { start: null, size: 1 };
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  return { start: min, size: max - min + 1 };
}

// ============================================================
// Helper: parse SSH credentials from "root / qwe123"
// ============================================================
function parseCredentials(credStr) {
  if (!credStr || credStr === '-') return { user: null, password: null };
  const s = String(credStr).trim();
  const match = s.match(/^([^\s\/]+)\s*\/\s*(.+)$/);
  if (match) return { user: match[1].trim(), password: match[2].trim() };
  return { user: null, password: null };
}

// ============================================================
// Helper: determine asset type from management number or model
// ============================================================
function determineAssetType(mgmtNum, model) {
  const m = (mgmtNum + ' ' + model).toLowerCase();
  if (m.includes('-n-') || m.includes('스위치') || m.includes('switch') || m.includes('l2') || m.includes('l3') || m.includes('e5224') || m.includes('인터커넥트')) return 'switch';
  if (m.includes('-pa-') || m.includes('전력') || m.includes('power meter') || m.includes('yokogawa')) return 'other';
  if (m.includes('pdu')) return 'pdu';
  if (m.includes('ups')) return 'ups';
  if (m.includes('-sto-') || m.includes('스토리지') || m.includes('storage') || m.includes('synology') || m.includes('nvme 스토리지')) return 'storage';
  if (m.includes('kvm') || m.includes('rack-42u') || m.includes('rack-37u')) return 'other';
  if (m.includes('wifi') || m.includes('iptime') || m.includes('공유기')) return 'other';
  if (m.includes('-pc-') || m.includes('데스크탑') || m.includes('desktop') || m.includes('tower') || m.includes('dt-') || m.includes('보스몬스터')) return 'other';
  if (m.includes('-gw-') || m.includes('iot') || m.includes('itguard') || m.includes('ig10') || m.includes('ie-th')) return 'other';
  if (m.includes('-tm-') || m.includes('temp')) return 'other';
  if (m.includes('lisn') || m.includes('트랜스') || m.includes('wyt')) return 'other';
  return 'server';
}

// ============================================================
// Helper: determine status
// ============================================================
function determineStatus(statusStr, purpose) {
  const s = String(statusStr || '').trim();
  const p = String(purpose || '').trim();
  if (s === '반납완료' || s === '출고' || s === '반납') return 'decommissioned';
  if (p === '-' || p === '') return 'active';
  if (s.includes('미사용') || s.includes('처분')) return 'inactive';
  return 'active';
}

// ============================================================
// Helper: clean IP address
// ============================================================
function cleanIp(ip) {
  if (!ip || ip === '-' || ip === '') return null;
  const s = String(ip).trim();
  if (s.startsWith('DHCP') || s.startsWith('192.168') || s.startsWith('192.100')) return null;
  const match = s.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/);
  return match ? match[1] : null;
}

// ============================================================
// Helper: Excel serial date → YYYY-MM-DD
// ============================================================
function excelDateToStr(serial) {
  if (!serial) return null;
  if (typeof serial === 'string') {
    // Already a date string?
    const m = String(serial).trim().match(/^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/);
    if (m) return serial.replace(/\//g, '-');
    return null;
  }
  if (typeof serial !== 'number' || serial < 1) return null;
  // Excel serial date → JS Date
  const d = new Date((serial - 25569) * 86400 * 1000);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().split('T')[0];
}

// ============================================================
// Helper: insert computing modules for an asset
// ============================================================
const moduleStmt = db.prepare(`
  INSERT INTO computing_modules (asset_id, module_type, model, manufacturer, capacity, count, specification)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

function insertModules(assetId, row, colOffset) {
  // CPU
  const cpuType = String(row[colOffset] || '').trim();
  const cpuNum = parseInt(row[colOffset + 1]) || 0;
  if (cpuType && cpuType !== '-' && cpuNum > 0) {
    const ref = cpuRef[cpuType];
    if (ref) {
      moduleStmt.run(assetId, 'cpu', ref.model, ref.manufacturer, ref.capacity, cpuNum, cpuType);
    } else {
      moduleStmt.run(assetId, 'cpu', cpuType, null, null, cpuNum, null);
    }
  }

  // Memory 1
  const mem1Type = String(row[colOffset + 2] || '').trim();
  const mem1Num = parseInt(row[colOffset + 3]) || 0;
  if (mem1Type && mem1Type !== '-' && mem1Num > 0) {
    const ref = memRef[mem1Type];
    if (ref) {
      moduleStmt.run(assetId, 'memory', ref.model, ref.manufacturer, ref.capacity, mem1Num, `${ref.spec} (${mem1Type})`);
    } else {
      moduleStmt.run(assetId, 'memory', mem1Type, null, null, mem1Num, null);
    }
  }

  // Memory 2
  const mem2Type = String(row[colOffset + 4] || '').trim();
  const mem2Num = parseInt(row[colOffset + 5]) || 0;
  if (mem2Type && mem2Type !== '-' && mem2Num > 0) {
    const ref = memRef[mem2Type];
    if (ref) {
      moduleStmt.run(assetId, 'memory', ref.model, ref.manufacturer, ref.capacity, mem2Num, `${ref.spec} (${mem2Type})`);
    } else {
      moduleStmt.run(assetId, 'memory', mem2Type, null, null, mem2Num, null);
    }
  }

  // Disks (4 slots)
  for (let d = 0; d < 4; d++) {
    const diskType = String(row[colOffset + 6 + d * 2] || '').trim();
    const diskNum = parseInt(row[colOffset + 7 + d * 2]) || 0;
    if (diskType && diskType !== '-' && diskNum > 0) {
      const ref = diskRef[diskType];
      if (ref) {
        moduleStmt.run(assetId, 'disk', ref.model, ref.manufacturer, ref.capacity, diskNum, diskType);
      } else {
        moduleStmt.run(assetId, 'disk', diskType, null, null, diskNum, null);
      }
    }
  }

  // NICs (4 slots)
  for (let n = 0; n < 4; n++) {
    const nicType = String(row[colOffset + 14 + n * 2] || '').trim();
    const nicNum = parseInt(row[colOffset + 15 + n * 2]) || 0;
    if (nicType && nicType !== '-' && nicNum > 0) {
      const ref = netRef[nicType];
      if (ref) {
        moduleStmt.run(assetId, 'network', ref.model, ref.manufacturer, ref.capacity, nicNum, nicType);
      } else {
        moduleStmt.run(assetId, 'network', nicType, null, null, nicNum, null);
      }
    }
  }

  // RAID
  const raidType = String(row[colOffset + 22] || '').trim();
  const raidNum = parseInt(row[colOffset + 23]) || 0;
  if (raidType && raidType !== '-' && raidNum > 0) {
    const ref = raidRef[raidType];
    if (ref) {
      moduleStmt.run(assetId, 'raid', ref.model, ref.manufacturer, null, raidNum, raidType);
    } else {
      moduleStmt.run(assetId, 'raid', raidType, null, null, raidNum, null);
    }
  }

  // GPU 1
  const gpu1Type = String(row[colOffset + 24] || '').trim();
  const gpu1Num = parseInt(row[colOffset + 25]) || 0;
  if (gpu1Type && gpu1Type !== '-' && gpu1Num > 0) {
    const ref = gpuRef[gpu1Type];
    if (ref) {
      moduleStmt.run(assetId, 'gpu', ref.model, ref.manufacturer, ref.capacity, gpu1Num, gpu1Type);
    } else {
      moduleStmt.run(assetId, 'gpu', gpu1Type, null, null, gpu1Num, null);
    }
  }

  // GPU 2
  const gpu2Type = String(row[colOffset + 26] || '').trim();
  const gpu2Num = parseInt(row[colOffset + 27]) || 0;
  if (gpu2Type && gpu2Type !== '-' && gpu2Num > 0) {
    const ref = gpuRef[gpu2Type];
    if (ref) {
      moduleStmt.run(assetId, 'gpu', ref.model, ref.manufacturer, ref.capacity, gpu2Num, gpu2Type);
    } else {
      moduleStmt.run(assetId, 'gpu', gpu2Type, null, null, gpu2Num, null);
    }
  }
}

// ============================================================
// Vendor cache
// ============================================================
const vendorCache = {};
function getOrCreateVendor(vendorName) {
  if (!vendorName || vendorName === '-' || vendorName === '') return null;
  const normalized = vendorName.trim();
  if (vendorCache[normalized]) return vendorCache[normalized];

  let v = db.prepare('SELECT id FROM vendor_info WHERE vendor_name = ?').get(normalized);
  if (!v) {
    const result = db.prepare('INSERT INTO vendor_info (vendor_name) VALUES (?)').run(normalized);
    v = { id: result.lastInsertRowid };
  }
  vendorCache[normalized] = v.id;
  return v.id;
}

// ============================================================
// Prepared statements
// ============================================================
const assetStmt = db.prepare(`
  INSERT INTO assets (asset_number, management_number, asset_type, ownership, vendor_id,
    model_name, manufacturer, serial_number, rack_id, rack_unit_start, rack_unit_size,
    ip_address, ssh_port, ssh_user, ssh_password, assigned_user, purpose, status,
    purchase_date, warranty_end, notes)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const ipStmt = db.prepare(`
  INSERT INTO asset_ips (asset_id, ip_address, ip_type, description) VALUES (?, ?, ?, ?)
`);

const credStmt = db.prepare(`
  INSERT INTO asset_credentials (asset_id, username, password, credential_type, description) VALUES (?, ?, ?, ?, ?)
`);

// ============================================================
// Helper: insert multiple IPs for an asset
// ============================================================
function insertIps(assetId, ips) {
  for (const ip of ips) {
    if (ip.address) {
      ipStmt.run(assetId, ip.address, ip.type || 'management', ip.description || null);
    }
  }
}

// ============================================================
// Helper: insert multiple credentials for an asset
// ============================================================
function insertCredentials(assetId, creds) {
  for (const cred of creds) {
    if (cred.username) {
      credStmt.run(assetId, cred.username, cred.password || null, cred.type || 'root', cred.description || null);
    }
  }
}

// ============================================================
// Clear existing data
// ============================================================
console.log('Clearing existing data...');
db.prepare('DELETE FROM lending_items').run();
db.prepare('DELETE FROM lendings').run();
db.prepare('DELETE FROM module_inventory').run();
db.prepare('DELETE FROM inventory_logs').run();
db.prepare('DELETE FROM asset_credentials').run();
db.prepare('DELETE FROM asset_ips').run();
db.prepare('DELETE FROM computing_modules').run();
db.prepare('DELETE FROM ip_addresses').run();
db.prepare('DELETE FROM assets').run();
db.prepare('DELETE FROM racks').run();
db.prepare('DELETE FROM server_rooms').run();

// ============================================================
// Import TTA (company-owned) assets
// ============================================================
console.log('\n=== Importing TTA assets (company) ===');
const ttaSheet = XLSX.utils.sheet_to_json(wb.Sheets['TTA용 서버 및 PC 현황'], { header: 1, defval: '' });

let ttaCount = 0;
let ttaModuleCount = 0;
let ttaIpCount = 0;
let ttaCredCount = 0;
const usedAssetNumbers = new Set();

const importTTA = db.transaction(() => {
  for (let i = 2; i < ttaSheet.length; i++) {
    const r = ttaSheet[i];
    const mgmtNum = String(r[2] || '').trim();
    const modelName = String(r[3] || '').trim();
    if (!mgmtNum && !modelName) continue;

    let assetNum = String(r[1] || '').trim();
    if (assetNum === '-' || assetNum === '') assetNum = null;
    if (assetNum === '처분예정') assetNum = null;

    // Skip duplicate asset numbers
    if (assetNum && usedAssetNumbers.has(assetNum)) {
      assetNum = assetNum + '_' + i;
    }
    if (assetNum) usedAssetNumbers.add(assetNum);

    const assetType = determineAssetType(mgmtNum, modelName);
    const roomName = String(r[17] || '').trim();
    const rackName = String(r[18] || '').trim();
    const unitStr = r[19];
    const { start: unitStart, size: unitSize } = parseUnit(unitStr);

    // Multi-IP: r[10]=IP(1), r[11]=IP(2), r[12]=IP(3), r[13]=IP(4), r[14]=BMC, r[15]=IB(1), r[16]=IB(2)
    const ips = [];
    const ip1 = cleanIp(r[10]);
    const ip2 = cleanIp(r[11]);
    const ip3 = cleanIp(r[12]);
    const ip4 = cleanIp(r[13]);
    const bmcIp = cleanIp(r[14]);
    const ib1 = cleanIp(r[15]);
    const ib2 = cleanIp(r[16]);

    if (ip1) ips.push({ address: ip1, type: 'management', description: 'IP(1)' });
    if (ip2) ips.push({ address: ip2, type: 'management', description: 'IP(2)' });
    if (ip3) ips.push({ address: ip3, type: 'management', description: 'IP(3)' });
    if (ip4) ips.push({ address: ip4, type: 'management', description: 'IP(4)' });
    if (bmcIp) ips.push({ address: bmcIp, type: 'bmc', description: 'BMC' });
    if (ib1) ips.push({ address: ib1, type: 'ib', description: 'IB(1)' });
    if (ib2) ips.push({ address: ib2, type: 'ib', description: 'IB(2)' });

    // First management IP for backward compatibility
    const primaryIp = ip1 || ip2 || ip3 || ip4 || null;

    // Multi-credentials: r[7]=root, r[8]=기타, r[9]=기타2
    const creds = [];
    const rootCred = parseCredentials(r[7]);
    const userCred1 = parseCredentials(r[8]);
    const userCred2 = parseCredentials(r[9]);

    if (rootCred.user) creds.push({ username: rootCred.user, password: rootCred.password, type: 'root', description: 'root 계정' });
    if (userCred1.user) creds.push({ username: userCred1.user, password: userCred1.password, type: 'user', description: '기타 계정' });
    if (userCred2.user) creds.push({ username: userCred2.user, password: userCred2.password, type: 'user', description: '기타 계정 2' });

    const user = String(r[4] || '').trim() || null;
    const purpose = [String(r[5] || '').trim(), String(r[6] || '').trim()].filter(x => x && x !== '-').join(' - ') || null;
    const statusVal = String(r[51] || '').trim();
    const status = determineStatus(statusVal, null);
    const os = String(r[49] || '').trim() || null;
    const notes = [String(r[50] || '').trim(), os ? `OS: ${os}` : ''].filter(Boolean).join('; ') || null;

    const roomId = getOrCreateRoom(roomName);
    // MEC rack mapping: MEC room maps to AIDC, rack name "친환경/고효율 Rack#9"
    let finalRackName = rackName;
    if (roomName && (roomName.includes('mec') || roomName.includes('MEC')) && (!rackName || rackName === '-')) {
      finalRackName = '친환경/고효율 Rack#9';
    }
    const rackId = roomId ? getOrCreateRack(roomId, finalRackName) : null;

    try {
      const result = assetStmt.run(
        assetNum, mgmtNum || null, assetType, 'company', null,
        modelName || null, null, null,
        rackId, unitStart, unitSize,
        primaryIp, 22, rootCred.user, rootCred.password,
        user, purpose, status,
        null, null, notes
      );
      const assetId = result.lastInsertRowid;
      ttaCount++;

      // Insert multi-IPs
      insertIps(assetId, ips);
      ttaIpCount += ips.length;

      // Insert multi-credentials
      insertCredentials(assetId, creds);
      ttaCredCount += creds.length;

      // Insert computing modules (col offset = 21 for TTA)
      const beforeCount = db.prepare('SELECT COUNT(*) as c FROM computing_modules').get().c;
      insertModules(assetId, r, 21);
      const afterCount = db.prepare('SELECT COUNT(*) as c FROM computing_modules').get().c;
      ttaModuleCount += (afterCount - beforeCount);
    } catch (err) {
      console.error(`  Error row ${i}: ${err.message} (asset_number=${assetNum})`);
    }
  }
});
importTTA();
console.log(`  Imported ${ttaCount} TTA assets, ${ttaModuleCount} modules, ${ttaIpCount} IPs, ${ttaCredCount} credentials`);

// ============================================================
// Import vendor assets
// ============================================================
console.log('\n=== Importing vendor assets ===');
const vendorSheet = XLSX.utils.sheet_to_json(wb.Sheets['업체용 서버 현황'], { header: 1, defval: '' });

let vendorCount = 0;
let vendorModuleCount = 0;
let vendorIpCount = 0;
let vendorCredCount = 0;

const importVendor = db.transaction(() => {
  for (let i = 3; i < vendorSheet.length; i++) {
    const r = vendorSheet[i];
    const vendorName = String(r[2] || '').trim();
    const statusVal = String(r[46] || '').trim();

    if (!vendorName) continue;
    if (statusVal === '반납완료') continue; // skip returned equipment

    // Skip BMC-only rows (IP 구분 = BMC with no other data)
    const ipType = String(r[11] || '').trim();
    if (ipType === 'BMC' && !String(r[8] || '').trim()) continue;

    const vendorId = getOrCreateVendor(vendorName);
    const roomName = String(r[4] || '').trim();
    const rackStr = String(r[5] || '').trim();
    const testName = String(r[8] || '').trim() || null;
    const tag = String(r[7] || '').trim() || null;
    const category = String(r[3] || '').trim() || null;

    // Multi-IP: r[12]=IP(1), r[13]=IP(2), r[14]=IP(3), r[15]=IP(4), r[16]=BMC, r[17]=IB(1), r[18]=IB(2)
    const ips = [];
    const vip1 = cleanIp(r[12]);
    const vip2 = cleanIp(r[13]);
    const vip3 = cleanIp(r[14]);
    const vip4 = cleanIp(r[15]);
    const vbmc = cleanIp(r[16]);
    const vib1 = cleanIp(r[17]);
    const vib2 = cleanIp(r[18]);

    if (vip1) ips.push({ address: vip1, type: 'management', description: 'IP(1)' });
    if (vip2) ips.push({ address: vip2, type: 'management', description: 'IP(2)' });
    if (vip3) ips.push({ address: vip3, type: 'management', description: 'IP(3)' });
    if (vip4) ips.push({ address: vip4, type: 'management', description: 'IP(4)' });
    if (vbmc) ips.push({ address: vbmc, type: 'bmc', description: 'BMC' });
    if (vib1) ips.push({ address: vib1, type: 'ib', description: 'IB(1)' });
    if (vib2) ips.push({ address: vib2, type: 'ib', description: 'IB(2)' });

    const primaryIp = vip1 || vip2 || vip3 || vip4 || null;

    // Multi-credentials: r[9]=root, r[10]=기타
    const creds = [];
    const vRootCred = parseCredentials(r[9]);
    const vUserCred = parseCredentials(r[10]);

    if (vRootCred.user) creds.push({ username: vRootCred.user, password: vRootCred.password, type: 'root', description: 'root 계정' });
    if (vUserCred.user) creds.push({ username: vUserCred.user, password: vUserCred.password, type: 'user', description: '기타 계정' });

    // Parse rack name and unit from combined string like "친환경/고효율 RACK#3(23, 24)"
    let rackName = rackStr;
    let unitStart = null;
    let unitSize = 1;
    const rackMatch = rackStr.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
    if (rackMatch) {
      rackName = rackMatch[1].trim();
      const parsed = parseUnit(rackMatch[2]);
      unitStart = parsed.start;
      unitSize = parsed.size;
    }
    if (rackName === '반출' || rackName === '' || rackName === '-') rackName = null;

    const roomId = getOrCreateRoom(roomName);
    const rackId = (roomId && rackName) ? getOrCreateRack(roomId, rackName) : null;

    // Generate a management-like number for vendor assets
    const assetNum = String(r[6] || '').trim() || null;
    const modelHint = tag || testName || category || vendorName;

    // Determine asset type
    let assetType = 'server';
    const combined = (String(r[8]) + ' ' + String(r[7]) + ' ' + String(r[3])).toLowerCase();
    if (combined.includes('스토리지') || combined.includes('storage')) assetType = 'storage';
    if (combined.includes('스위치') || combined.includes('switch')) assetType = 'switch';
    if (combined.includes('전력') || combined.includes('power')) assetType = 'other';

    const purpose = [category, testName].filter(x => x && x !== '-').join(' - ') || null;
    const notes = tag || null;

    try {
      // Use a unique asset_number for vendor assets
      let uniqueAssetNum = assetNum;
      if (!uniqueAssetNum) {
        uniqueAssetNum = `V-${vendorName.replace(/[^a-zA-Z0-9가-힣]/g, '')}-${i}`;
      }
      if (usedAssetNumbers.has(uniqueAssetNum)) {
        uniqueAssetNum = uniqueAssetNum + '_' + i;
      }
      usedAssetNumbers.add(uniqueAssetNum);

      const result = assetStmt.run(
        uniqueAssetNum, null, assetType, 'vendor', vendorId,
        modelHint || null, vendorName, null,
        rackId, unitStart, unitSize,
        primaryIp, 22, vRootCred.user, vRootCred.password,
        null, purpose, 'active',
        null, null, notes
      );
      const assetId = result.lastInsertRowid;
      vendorCount++;

      // Insert multi-IPs
      insertIps(assetId, ips);
      vendorIpCount += ips.length;

      // Insert multi-credentials
      insertCredentials(assetId, creds);
      vendorCredCount += creds.length;

      // Insert computing modules for vendor assets
      const beforeCount = db.prepare('SELECT COUNT(*) as c FROM computing_modules').get().c;

      // CPU: [20]CPU Type(manufacturer context) [21]CPU model [22]CPU Num
      const cpuModel = String(r[21] || '').trim();
      const cpuNum = parseInt(r[22]) || 0;
      if (cpuModel && cpuModel !== '-' && cpuNum > 0) {
        moduleStmt.run(assetId, 'cpu', cpuModel, String(r[20] || '').trim() || null, null, cpuNum, null);
      }

      // Memory: [23]Mem Type [24]Mem Num [25]Mem Size
      const memType = String(r[23] || '').trim();
      const memNum = parseInt(r[24]) || 0;
      const memSize = String(r[25] || '').trim();
      if (memType && memType !== '-' && memNum > 0) {
        const ref = memRef[memType];
        if (ref) {
          moduleStmt.run(assetId, 'memory', ref.model, ref.manufacturer, ref.capacity, memNum, `${ref.spec} (${memType})`);
        } else {
          moduleStmt.run(assetId, 'memory', memType, null, memSize || null, memNum, null);
        }
      }

      // Disk OS: [26]Type [27]Size [28]Num
      const diskOsType = String(r[26] || '').trim();
      const diskOsNum = parseInt(r[28]) || 0;
      const diskOsSize = String(r[27] || '').trim();
      if (diskOsType && diskOsType !== '-' && diskOsNum > 0) {
        moduleStmt.run(assetId, 'disk', diskOsType, null, diskOsSize || null, diskOsNum, 'OS disk');
      }

      // Disk Data 1: [29]Type [30]Size [31]Num
      const diskD1Type = String(r[29] || '').trim();
      const diskD1Num = parseInt(r[31]) || 0;
      const diskD1Size = String(r[30] || '').trim();
      if (diskD1Type && diskD1Type !== '-' && diskD1Num > 0) {
        moduleStmt.run(assetId, 'disk', diskD1Type, null, diskD1Size || null, diskD1Num, 'Data disk');
      }

      // Disk Data 2: [32]Type [33]Size [34]Num
      const diskD2Type = String(r[32] || '').trim();
      const diskD2Num = parseInt(r[34]) || 0;
      const diskD2Size = String(r[33] || '').trim();
      if (diskD2Type && diskD2Type !== '-' && diskD2Num > 0) {
        moduleStmt.run(assetId, 'disk', diskD2Type, null, diskD2Size || null, diskD2Num, 'Data disk');
      }

      // Disk Data 3: [35]Type [36]Size [37]Num
      const diskD3Type = String(r[35] || '').trim();
      const diskD3Num = parseInt(r[37]) || 0;
      const diskD3Size = String(r[36] || '').trim();
      if (diskD3Type && diskD3Type !== '-' && diskD3Num > 0) {
        moduleStmt.run(assetId, 'disk', diskD3Type, null, diskD3Size || null, diskD3Num, 'Data disk');
      }

      // NIC: [38]Type [39]Num
      const nicType = String(r[38] || '').trim();
      const nicNum = parseInt(r[39]) || 0;
      if (nicType && nicType !== '-' && nicNum > 0) {
        const ref = netRef[nicType];
        if (ref) {
          moduleStmt.run(assetId, 'network', ref.model, ref.manufacturer, ref.capacity, nicNum, nicType);
        } else {
          moduleStmt.run(assetId, 'network', nicType, null, null, nicNum, null);
        }
      }

      // RAID: [40]Type [41]Num
      const raidType = String(r[40] || '').trim();
      const raidNum = parseInt(r[41]) || 0;
      if (raidType && raidType !== '-' && raidNum > 0) {
        const ref = raidRef[raidType];
        if (ref) {
          moduleStmt.run(assetId, 'raid', ref.model, ref.manufacturer, null, raidNum, raidType);
        } else {
          moduleStmt.run(assetId, 'raid', raidType, null, null, raidNum, null);
        }
      }

      // GPU: [42]Type [43]Num
      const gpuType = String(r[42] || '').trim();
      const gpuNum = parseInt(r[43]) || 0;
      if (gpuType && gpuType !== '-' && gpuNum > 0) {
        const ref = gpuRef[gpuType];
        if (ref) {
          moduleStmt.run(assetId, 'gpu', ref.model, ref.manufacturer, ref.capacity, gpuNum, gpuType);
        } else {
          moduleStmt.run(assetId, 'gpu', gpuType, null, null, gpuNum, null);
        }
      }

      const afterCount = db.prepare('SELECT COUNT(*) as c FROM computing_modules').get().c;
      vendorModuleCount += (afterCount - beforeCount);
    } catch (err) {
      console.error(`  Error vendor row ${i}: ${err.message}`);
    }
  }
});
importVendor();
console.log(`  Imported ${vendorCount} vendor assets, ${vendorModuleCount} modules, ${vendorIpCount} IPs, ${vendorCredCount} credentials`);

// ============================================================
// Import Lending: TTA → 외부 (outbound)
// ============================================================
console.log('\n=== Importing Lendings (TTA→외부, outbound) ===');
const outboundSheetName = Object.keys(wb.Sheets).find(n => n.includes('대여') && n.includes('TTA') && n.includes('외부') && !n.includes('외부 ->'));
let lendingOutCount = 0;

if (outboundSheetName && wb.Sheets[outboundSheetName]) {
  const outSheet = XLSX.utils.sheet_to_json(wb.Sheets[outboundSheetName], { header: 1, defval: '' });
  const lendingStmt = db.prepare(`
    INSERT INTO lendings (direction, counterparty, loan_date, return_date, status, notes) VALUES (?, ?, ?, ?, ?, ?)
  `);
  const lendingItemStmt = db.prepare(`
    INSERT INTO lending_items (lending_id, item_type, item_code, quantity, description) VALUES (?, ?, ?, ?, ?)
  `);

  const importOutbound = db.transaction(() => {
    for (let i = 2; i < outSheet.length; i++) {
      const r = outSheet[i];
      const counterparty = String(r[1] || '').trim();
      if (!counterparty) continue;

      const loanDate = excelDateToStr(r[0]);
      const returnDate = excelDateToStr(r[17]) || null;

      // Determine status from item codes - if any contain "(반납완료)"
      let isReturned = false;
      // Check columns 2-15 for "(반납완료)" marker
      for (let c = 2; c <= 15; c++) {
        if (String(r[c] || '').includes('(반납완료)')) { isReturned = true; break; }
      }
      const status = isReturned ? 'returned' : 'active';
      const notes = String(r[16] || '').trim() || null;

      try {
        const result = lendingStmt.run('outbound', counterparty, loanDate, returnDate, status, notes);
        const lendingId = result.lastInsertRowid;
        lendingOutCount++;

        // Items: CPU(2-3), Mem(4-5), DiskOS(6-7), DiskData(8-9), NIC(10-11), Raid(12-13), GPU(14-15)
        const itemPairs = [
          { type: 'cpu', codeCol: 2, qtyCol: 3 },
          { type: 'memory', codeCol: 4, qtyCol: 5 },
          { type: 'disk', codeCol: 6, qtyCol: 7, desc: 'OS Disk' },
          { type: 'disk', codeCol: 8, qtyCol: 9, desc: 'Data Disk' },
          { type: 'network', codeCol: 10, qtyCol: 11 },
          { type: 'raid', codeCol: 12, qtyCol: 13 },
          { type: 'gpu', codeCol: 14, qtyCol: 15 }
        ];

        for (const ip of itemPairs) {
          let code = String(r[ip.codeCol] || '').trim();
          const qty = parseInt(r[ip.qtyCol]) || 0;
          if (!code || code === '-' || qty <= 0) continue;
          // Strip "(반납완료)" from code
          code = code.replace(/\(반납완료\)/g, '').trim();
          lendingItemStmt.run(lendingId, ip.type, code, qty, ip.desc || null);
        }
      } catch (err) {
        console.error(`  Error outbound lending row ${i}: ${err.message}`);
      }
    }
  });
  importOutbound();
  console.log(`  Imported ${lendingOutCount} outbound lendings`);
} else {
  console.log('  Sheet not found, skipping outbound lending import');
}

// ============================================================
// Import Lending: 외부 → TTA (inbound)
// ============================================================
console.log('\n=== Importing Lendings (외부→TTA, inbound) ===');
const inboundSheetName = Object.keys(wb.Sheets).find(n => n.includes('대여') && n.includes('외부') && (n.includes('-> TTA') || n.includes('→ TTA') || n.includes('> TTA')));
let lendingInCount = 0;

if (inboundSheetName && wb.Sheets[inboundSheetName]) {
  const inSheet = XLSX.utils.sheet_to_json(wb.Sheets[inboundSheetName], { header: 1, defval: '' });
  const lendingStmt2 = db.prepare(`
    INSERT INTO lendings (direction, counterparty, loan_date, return_date, status, notes) VALUES (?, ?, ?, ?, ?, ?)
  `);
  const lendingItemStmt2 = db.prepare(`
    INSERT INTO lending_items (lending_id, item_type, item_code, quantity, description) VALUES (?, ?, ?, ?, ?)
  `);

  const importInbound = db.transaction(() => {
    for (let i = 2; i < inSheet.length; i++) {
      const r = inSheet[i];
      const counterparty = String(r[1] || '').trim();
      if (!counterparty) continue;

      const loanDate = excelDateToStr(r[0]);
      const returnDate = excelDateToStr(r[22]) || null;

      // Determine status
      let isReturned = false;
      for (let c = 2; c <= 20; c++) {
        if (String(r[c] || '').includes('(반납완료)') || String(r[c] || '').includes('(회수)')) { isReturned = true; break; }
      }
      if (returnDate) isReturned = true;
      const status = isReturned ? 'returned' : 'active';
      const notes = String(r[21] || '').trim() || null;

      try {
        const result = lendingStmt2.run('inbound', counterparty, loanDate, returnDate, status, notes);
        const lendingId = result.lastInsertRowid;
        lendingInCount++;

        // Items: CPU(2,3,4), Mem(5,6,7), DiskOS(8,9,10), DiskData(11,12,13), NIC(15,16), Raid(17,18), GPU(19,20)
        const inItemPairs = [
          { type: 'cpu', codeCol: 2, qtyCol: 3, descCol: 4 },
          { type: 'memory', codeCol: 5, qtyCol: 6, descCol: 7 },
          { type: 'disk', codeCol: 8, qtyCol: 9, descCol: 10, desc: 'OS Disk' },
          { type: 'disk', codeCol: 11, qtyCol: 12, descCol: 13, desc: 'Data Disk' },
          { type: 'network', codeCol: 15, qtyCol: 16 },
          { type: 'raid', codeCol: 17, qtyCol: 18 },
          { type: 'gpu', codeCol: 19, qtyCol: 20 }
        ];

        for (const ip of inItemPairs) {
          let code = String(r[ip.codeCol] || '').trim();
          const qty = parseInt(r[ip.qtyCol]) || 0;
          if (!code || code === '-' || qty <= 0) continue;
          code = code.replace(/\(반납완료\)/g, '').replace(/\(회수\)/g, '').trim();
          const desc = ip.descCol ? String(r[ip.descCol] || '').trim() || ip.desc || null : ip.desc || null;
          lendingItemStmt2.run(lendingId, ip.type, code, qty, desc);
        }
      } catch (err) {
        console.error(`  Error inbound lending row ${i}: ${err.message}`);
      }
    }
  });
  importInbound();
  console.log(`  Imported ${lendingInCount} inbound lendings`);
} else {
  console.log('  Sheet not found, skipping inbound lending import');
}

// ============================================================
// Import 판교IP 사용현황 → ip_addresses sync
// ============================================================
console.log('\n=== Importing IP addresses (판교IP 사용현황) ===');
const ipSheetName = Object.keys(wb.Sheets).find(n => n.includes('판교IP') || n.includes('IP 사용'));
let ipImportCount = 0;

// Subnet definitions matching the 9 subnets in app config
const subnetDefs = [
  { subnet: '10.100.40.0/24', zone: 'office' },
  { subnet: '10.100.50.0/24', zone: 'office' },
  { subnet: '10.100.250.0/24', zone: 'hpc' },
  { subnet: '10.100.251.0/24', zone: 'hpc' },
  { subnet: '10.100.252.0/24', zone: 'hpc' },
  { subnet: '10.100.230.0/24', zone: 'aidc' },
  { subnet: '10.100.231.0/24', zone: 'aidc' },
  { subnet: '10.100.232.0/24', zone: 'aidc' },
  { subnet: '10.100.233.0/24', zone: 'aidc' }
];

if (ipSheetName && wb.Sheets[ipSheetName]) {
  const ipSheet = XLSX.utils.sheet_to_json(wb.Sheets[ipSheetName], { header: 1, defval: '' });

  // Build a map of asset_ips for cross-referencing
  const assetIpMap = {};
  const allAssetIps = db.prepare('SELECT ai.ip_address, ai.asset_id FROM asset_ips ai').all();
  allAssetIps.forEach(row => { assetIpMap[row.ip_address] = row.asset_id; });

  const ipInsertStmt = db.prepare(`
    INSERT OR IGNORE INTO ip_addresses (ip_address, subnet, network_zone, allocation_type, asset_id, assigned_to)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const importIps = db.transaction(() => {
    // The sheet layout: col 0 = row index, then 9 pairs of (IP, status) starting from col 1
    // Col 1,2 = subnet1(IP,status), Col 3,4 = subnet2, ..., Col 17,18 = subnet9
    // Data rows start at row 3 (rows 0-2 are headers)
    for (let row = 3; row < ipSheet.length; row++) {
      const r = ipSheet[row];
      // 9 subnet pairs starting from col 1
      for (let pairIdx = 0; pairIdx < 9; pairIdx++) {
        const ipCol = 1 + pairIdx * 2;
        const statusCol = 2 + pairIdx * 2;
        const ipVal = String(r[ipCol] || '').trim();
        const statusVal = String(r[statusCol] || '').trim();

        // Check if this looks like an IP address
        if (!ipVal.match(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/)) continue;

        // Determine which subnet this IP belongs to
        const ipParts = ipVal.split('.');
        const subnetBase = ipParts[0] + '.' + ipParts[1] + '.' + ipParts[2] + '.0/24';
        const subnetDef = subnetDefs.find(s => s.subnet === subnetBase);
        if (!subnetDef) continue;

        let allocationType = 'available';
        let assignedTo = null;
        let assetId = null;

        if (statusVal && statusVal !== '미사용' && statusVal !== '' && statusVal !== '-') {
          allocationType = 'assigned';
          assignedTo = statusVal;
        }

        // Check if this IP is in asset_ips
        if (assetIpMap[ipVal]) {
          assetId = assetIpMap[ipVal];
          allocationType = 'assigned';
        }

        try {
          ipInsertStmt.run(ipVal, subnetDef.subnet, subnetDef.zone, allocationType, assetId, assignedTo);
          ipImportCount++;
        } catch (err) {
          // Ignore duplicate errors
        }
      }
    }
  });
  importIps();
  console.log(`  Imported ${ipImportCount} IP address records`);
} else {
  console.log('  IP sheet not found, initializing subnets from config...');
  // Fallback: initialize subnets with available IPs
  const ipInsertStmt = db.prepare(`
    INSERT OR IGNORE INTO ip_addresses (ip_address, subnet, network_zone, allocation_type)
    VALUES (?, ?, ?, 'available')
  `);
  const initIps = db.transaction(() => {
    subnetDefs.forEach(s => {
      const parts = s.subnet.split('/')[0].split('.');
      for (let i = 0; i < 256; i++) {
        const ip = parts[0] + '.' + parts[1] + '.' + parts[2] + '.' + i;
        ipInsertStmt.run(ip, s.subnet, s.zone);
      }
    });
  });
  initIps();
  ipImportCount = 9 * 256;

  // Sync with asset_ips
  const allAssetIps = db.prepare('SELECT ai.ip_address, ai.asset_id FROM asset_ips ai').all();
  const updateIpStmt = db.prepare(`
    UPDATE ip_addresses SET allocation_type='assigned', asset_id=? WHERE ip_address=?
  `);
  const syncIps = db.transaction(() => {
    allAssetIps.forEach(row => {
      updateIpStmt.run(row.asset_id, row.ip_address);
    });
  });
  syncIps();
  console.log(`  Initialized ${ipImportCount} IPs, synced ${allAssetIps.length} from asset_ips`);
}

// ============================================================
// Also sync asset_ips → ip_addresses for any remaining IPs
// ============================================================
console.log('\n=== Syncing asset_ips → ip_addresses ===');
const remainingAssetIps = db.prepare(`
  SELECT ai.ip_address, ai.asset_id
  FROM asset_ips ai
  WHERE ai.ip_address IN (SELECT ip_address FROM ip_addresses WHERE allocation_type = 'available')
`).all();

if (remainingAssetIps.length > 0) {
  const syncStmt = db.prepare(`
    UPDATE ip_addresses SET allocation_type='assigned', asset_id=? WHERE ip_address=?
  `);
  const syncTx = db.transaction(() => {
    remainingAssetIps.forEach(row => {
      syncStmt.run(row.asset_id, row.ip_address);
    });
  });
  syncTx();
  console.log(`  Synced ${remainingAssetIps.length} IPs from asset_ips → ip_addresses`);
} else {
  console.log('  No additional IPs to sync');
}

// ============================================================
// Import 장비부속재료현황(세부) → module_inventory
// ============================================================
console.log('\n=== Importing Module Inventory (장비부속재료현황) ===');
let moduleInvCount = 0;

const modInvStmt = db.prepare(`
  INSERT OR REPLACE INTO module_inventory (module_type, item_code, label, manufacturer, model, capacity, specification,
    total_quantity, in_use_quantity, spare_quantity, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
`);

// Parse module_inventory from the ref sheet
// Layout: rows contain item_code in col 0, with quantity info in specific columns depending on section
// Memory: rows 0-32, qty cols 16-18 (total, in_use, spare)
// NIC: rows 34-52, qty cols 7-9
// RAID: rows 53-62, qty cols 7-9
// Storage: rows 63-97, qty cols 16-18
// CPU: rows 98-115, qty cols 7-9
// GPU: rows 116-121, qty cols 16-18

const importModInv = db.transaction(() => {
  // Define sections with their row ranges, module type, and qty column offsets
  const sections = [
    { type: 'memory', startRow: 0, endRow: 32, qtyOffset: 16 },
    { type: 'network', startRow: 34, endRow: 52, qtyOffset: 7 },
    { type: 'raid', startRow: 53, endRow: 62, qtyOffset: 7 },
    { type: 'disk', startRow: 63, endRow: 97, qtyOffset: 16 },
    { type: 'cpu', startRow: 98, endRow: 115, qtyOffset: 7 },
    { type: 'gpu', startRow: 116, endRow: 121, qtyOffset: 16 }
  ];

  for (const sec of sections) {
    for (let i = sec.startRow; i <= sec.endRow && i < refSheet.length; i++) {
      const r = refSheet[i];
      const itemCode = String(r[0] || '').trim();
      if (!itemCode || itemCode === '타입명' || itemCode.includes('재고') || itemCode.includes('용도') || itemCode.includes('총')) continue;

      // Check if this looks like a valid item code
      if (!itemCode.match(/^(mem-|net-|sto-|raid-|CPU-|GPU-)/)) continue;

      const totalQty = parseInt(r[sec.qtyOffset]) || 0;
      const inUseQty = parseInt(r[sec.qtyOffset + 1]) || 0;
      const spareQty = parseInt(r[sec.qtyOffset + 2]) || 0;

      // Get reference info
      let mfr = null, model = null, capacity = null, spec = null, label = null;
      if (sec.type === 'memory' && memRef[itemCode]) {
        const ref = memRef[itemCode];
        mfr = ref.manufacturer; model = ref.model; capacity = ref.capacity; spec = ref.spec;
      } else if (sec.type === 'network' && netRef[itemCode]) {
        const ref = netRef[itemCode];
        mfr = ref.manufacturer; model = ref.model; capacity = ref.capacity;
      } else if (sec.type === 'disk' && diskRef[itemCode]) {
        const ref = diskRef[itemCode];
        mfr = ref.manufacturer; model = ref.model; capacity = ref.capacity;
      } else if (sec.type === 'raid' && raidRef[itemCode]) {
        const ref = raidRef[itemCode];
        mfr = ref.manufacturer; model = ref.model;
      } else if (sec.type === 'cpu' && cpuRef[itemCode]) {
        const ref = cpuRef[itemCode];
        mfr = ref.manufacturer; model = ref.model; capacity = ref.capacity;
      } else if (sec.type === 'gpu' && gpuRef[itemCode]) {
        const ref = gpuRef[itemCode];
        mfr = ref.manufacturer; model = ref.model; capacity = ref.capacity;
      }

      // Build a label from row data
      label = String(r[1] || '').trim() || null;

      try {
        modInvStmt.run(sec.type, itemCode, label, mfr, model, capacity, spec, totalQty, inUseQty, spareQty);
        moduleInvCount++;
      } catch (err) {
        console.error(`  Error module_inventory row ${i}: ${err.message}`);
      }
    }
  }
});
importModInv();
console.log(`  Imported ${moduleInvCount} module inventory items`);

// ============================================================
// Import 입출고관리 → inventory_logs
// ============================================================
console.log('\n=== Importing Inventory Logs (입출고관리) ===');
const invLogSheetName = Object.keys(wb.Sheets).find(n => n.includes('입출고관리'));
let invLogCount = 0;

if (invLogSheetName && wb.Sheets[invLogSheetName]) {
  const invLogSheet = XLSX.utils.sheet_to_json(wb.Sheets[invLogSheetName], { header: 1, defval: '' });
  const invLogStmt = db.prepare(`
    INSERT INTO inventory_logs (log_type, item_name, item_type, quantity, serial_number, vendor_name, handler, purpose, notes, log_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const importInvLogs = db.transaction(() => {
    for (let i = 2; i < invLogSheet.length; i++) {
      const r = invLogSheet[i];
      const useStatus = String(r[52] || '').trim();
      if (!useStatus) continue;

      let logType = 'inbound';
      if (useStatus === '반납완료' || useStatus === '출고' || useStatus === '반납') {
        logType = 'outbound';
      } else if (useStatus === '입고' || useStatus === '사용중' || useStatus === '운영중') {
        logType = 'inbound';
      } else {
        continue; // skip unknown
      }

      const itemName = String(r[4] || '').trim() || String(r[3] || '').trim();
      if (!itemName) continue;

      const handler = String(r[5] || '').trim() || null;
      const assetType = determineAssetType(String(r[2] || ''), itemName);
      const logDate = excelDateToStr(r[1]) || excelDateToStr(r[0]) || null;
      const purpose = String(r[6] || '').trim() || null;
      const notes = String(r[50] || '').trim() || null;

      try {
        invLogStmt.run(logType, itemName, assetType, 1, null, null, handler, purpose, notes, logDate);
        invLogCount++;
      } catch (err) {
        console.error(`  Error inventory log row ${i}: ${err.message}`);
      }
    }
  });
  importInvLogs();
  console.log(`  Imported ${invLogCount} inventory log entries`);
} else {
  console.log('  Inventory log sheet not found, skipping');
}

// ============================================================
// Summary
// ============================================================
const totalAssets = db.prepare('SELECT COUNT(*) as c FROM assets').get().c;
const totalModules = db.prepare('SELECT COUNT(*) as c FROM computing_modules').get().c;
const totalRooms = db.prepare('SELECT COUNT(*) as c FROM server_rooms').get().c;
const totalRacks = db.prepare('SELECT COUNT(*) as c FROM racks').get().c;
const totalVendors = db.prepare('SELECT COUNT(*) as c FROM vendor_info').get().c;
const totalIps = db.prepare('SELECT COUNT(*) as c FROM asset_ips').get().c;
const totalCreds = db.prepare('SELECT COUNT(*) as c FROM asset_credentials').get().c;
const totalLendings = db.prepare('SELECT COUNT(*) as c FROM lendings').get().c;
const totalLendingItems = db.prepare('SELECT COUNT(*) as c FROM lending_items').get().c;
const totalModInv = db.prepare('SELECT COUNT(*) as c FROM module_inventory').get().c;
const totalInvLogs = db.prepare('SELECT COUNT(*) as c FROM inventory_logs').get().c;
const totalIpAddrs = db.prepare('SELECT COUNT(*) as c FROM ip_addresses').get().c;
const assignedIps = db.prepare("SELECT COUNT(*) as c FROM ip_addresses WHERE allocation_type = 'assigned'").get().c;

console.log('\n=== Import Summary ===');
console.log(`Server Rooms: ${totalRooms}`);
console.log(`Racks: ${totalRacks}`);
console.log(`Assets: ${totalAssets} (TTA: ${ttaCount}, Vendor: ${vendorCount})`);
console.log(`Computing Modules: ${totalModules}`);
console.log(`Asset IPs: ${totalIps}`);
console.log(`Asset Credentials: ${totalCreds}`);
console.log(`Vendors: ${totalVendors}`);
console.log(`Lendings: ${totalLendings} (items: ${totalLendingItems})`);
console.log(`Module Inventory: ${totalModInv}`);
console.log(`Inventory Logs: ${totalInvLogs}`);
console.log(`IP Addresses: ${totalIpAddrs} (assigned: ${assignedIps})`);

// Show rooms and racks
const rooms = db.prepare('SELECT * FROM server_rooms ORDER BY name').all();
rooms.forEach(room => {
  const racks = db.prepare('SELECT name FROM racks WHERE room_id = ? ORDER BY name').all(room.id);
  console.log(`  ${room.name} [${room.location_type || 'server_room'}]: ${racks.map(r => r.name).join(', ') || '(no racks)'}`);
});

db.close();
console.log('\nDone!');
