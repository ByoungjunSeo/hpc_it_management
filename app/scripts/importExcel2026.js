/**
 * Import script: 2026년 입출고관리.xlsx → SQLite DB
 * - Sheet 1 "입출고관리": equipment_usage_logs (281 rows)
 * - Sheet 2 "장비부속재료현황(세부)": module_inventory
 * - Derives assets, rooms, racks, computing_modules, asset_ips, asset_credentials
 *   from latest usage entries per management_number
 */
const XLSX = require('xlsx');
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'it_assets.db');
const EXCEL_PATH = path.join(__dirname, '..', '..', '2026년 입출고관리.xlsx');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Load schema to ensure tables exist
const fs = require('fs');
const schemaPath = path.join(__dirname, '..', 'db', 'schema.sql');
db.exec(fs.readFileSync(schemaPath, 'utf-8'));

// Ensure location_type column
const columns = db.prepare("PRAGMA table_info(server_rooms)").all();
if (!columns.some(c => c.name === 'location_type')) {
  db.exec("ALTER TABLE server_rooms ADD COLUMN location_type TEXT DEFAULT 'server_room'");
}
// Ensure room_id on assets
const assetCols = db.prepare("PRAGMA table_info(assets)").all();
if (!assetCols.some(c => c.name === 'room_id')) {
  db.exec("ALTER TABLE assets ADD COLUMN room_id INTEGER REFERENCES server_rooms(id)");
}

const wb = XLSX.readFile(EXCEL_PATH);
console.log('Sheets found:', wb.SheetNames);

// ============================================================
// Helper: Excel serial date → YYYY-MM-DD
// ============================================================
function excelDateToStr(serial) {
  if (!serial) return null;
  if (typeof serial === 'string') {
    const m = String(serial).trim().match(/^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/);
    if (m) return serial.replace(/\//g, '-');
    return null;
  }
  if (typeof serial !== 'number' || serial < 1) return null;
  const d = new Date((serial - 25569) * 86400 * 1000);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().split('T')[0];
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
// Helper: determine asset type
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
// Helper: parse unit string like "3", "15, 16", "2,3,4,5", "1 ~ 18"
// ============================================================
function parseUnit(unitStr) {
  if (!unitStr || unitStr === '-' || unitStr === '') return { start: null, size: 1 };
  const s = String(unitStr).trim();
  if (s.includes('~')) {
    const parts = s.split('~').map(x => parseInt(x.trim()));
    if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
      return { start: parts[0], size: parts[1] - parts[0] + 1 };
    }
  }
  const nums = s.split(/[,\s]+/).map(x => parseInt(x.trim())).filter(x => !isNaN(x));
  if (nums.length === 0) return { start: null, size: 1 };
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  return { start: min, size: max - min + 1 };
}

// ============================================================
// Room / Rack helpers
// ============================================================
const roomCache = {};
function getOrCreateRoom(roomName) {
  if (!roomName || roomName === '-' || roomName === '') return null;
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
    db.prepare('UPDATE server_rooms SET location_type = ? WHERE id = ? AND (location_type IS NULL OR location_type = ?)').run(locationType, room.id, 'server_room');
  }
  roomCache[normalized] = room.id;
  return room.id;
}

const rackCache = {};
function getOrCreateRack(roomId, rackName) {
  if (!roomId || !rackName || rackName === '-' || rackName === '') return null;
  let normalized = rackName.trim();
  normalized = normalized.replace(/RACK/i, 'Rack');
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
// Step 1: Clear all existing data
// ============================================================
console.log('Clearing all existing data...');
db.exec(`
  DELETE FROM lending_items;
  DELETE FROM lendings;
  DELETE FROM module_inventory;
  DELETE FROM inventory_logs;
  DELETE FROM asset_credentials;
  DELETE FROM asset_ips;
  DELETE FROM computing_modules;
  DELETE FROM network_connections;
  DELETE FROM power_nodes;
  DELETE FROM assets;
  DELETE FROM racks;
  DELETE FROM server_rooms;
  DELETE FROM equipment_usage_logs;
  DELETE FROM audit_logs;
`);
console.log('All existing data cleared.');

// ============================================================
// Step 2: Import Sheet 2 → module_inventory
// ============================================================
console.log('\n=== Importing Module Inventory (장비부속재료현황) ===');
const refSheetName = wb.SheetNames.find(n => n.includes('장비부속재료현황'));
let moduleInvCount = 0;

// Build reference maps
const cpuRef = {};
const memRef = {};
const diskRef = {};
const netRef = {};
const raidRef = {};
const gpuRef = {};

if (refSheetName) {
  const refSheet = XLSX.utils.sheet_to_json(wb.Sheets[refSheetName], { header: 1, defval: '' });
  console.log(`  Reference sheet "${refSheetName}" has ${refSheet.length} rows`);

  // Build lookup maps
  for (let i = 0; i < refSheet.length; i++) {
    const r = refSheet[i];
    const col0 = String(r[0] || '').trim();
    const col1 = String(r[1] || '').trim();
    if (!col0 || col0 === '타입명' || col0.includes('재고') || col0.includes('용도')) continue;

    // Memory: code is in col[1] (col[0] has usage category like "서버용")
    if (col1.startsWith('mem-')) {
      memRef[col1] = { manufacturer: r[2], model: r[4] || col1, capacity: r[3], spec: `${r[6] || ''} ${r[5] || ''} ${r[8] || ''}`.trim() };
    } else if (col0.startsWith('net-')) {
      netRef[col0] = { manufacturer: r[3], model: r[4], capacity: r[9] };
    } else if (col0.startsWith('sto-')) {
      diskRef[col0] = { manufacturer: r[1], model: r[2], capacity: r[6] };
    } else if (col0.startsWith('raid-')) {
      raidRef[col0] = { manufacturer: r[1], model: r[2] };
    } else if (col0.startsWith('CPU-')) {
      cpuRef[col0] = { manufacturer: r[1], model: r[2], capacity: `${r[4] || ''}C/${r[5] || ''}T ${r[6] || ''}`.trim() };
    } else if (col0.startsWith('GPU-')) {
      gpuRef[col0] = { manufacturer: r[1], model: r[2], capacity: r[3] };
    }
  }

  // Insert module_inventory
  const modInvStmt = db.prepare(`
    INSERT OR REPLACE INTO module_inventory (module_type, item_code, label, manufacturer, model, capacity, specification,
      total_quantity, in_use_quantity, spare_quantity, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `);

  // Define sections
  // Section definitions with correct qty column offsets for 2026 xlsx
  // Memory: [16]=총수량, [17]=사용중, [18]=장비실
  // Network: [10]=총수량, [11]=사용중, [12]=장비실
  // RAID: [7]=총수량, [8]=사용중, [9]=장비실
  // Storage: [16]=총수량, [17]=사용중, [18]=장비실
  // CPU: [7]=총수량, [8]=사용중, [9]=장비실
  // GPU: [6]=총수량, [7]=사용중, [8]=장비실
  const sections = [
    { type: 'memory', startRow: 0, endRow: 32, qtyOffset: 16 },
    { type: 'network', startRow: 34, endRow: 52, qtyOffset: 10 },
    { type: 'raid', startRow: 53, endRow: 62, qtyOffset: 7 },
    { type: 'disk', startRow: 63, endRow: 97, qtyOffset: 16 },
    { type: 'cpu', startRow: 98, endRow: 115, qtyOffset: 7 },
    { type: 'gpu', startRow: 116, endRow: 125, qtyOffset: 6 }
  ];

  const importModInv = db.transaction(() => {
    for (const sec of sections) {
      for (let i = sec.startRow; i <= sec.endRow && i < refSheet.length; i++) {
        const r = refSheet[i];

        // Memory codes are in column [1], other types in column [0]
        let itemCode;
        let label;
        if (sec.type === 'memory') {
          itemCode = String(r[1] || '').trim();
          label = String(r[0] || '').trim() || null; // usage category as label
        } else {
          itemCode = String(r[0] || '').trim();
          label = String(r[1] || '').trim() || null;
        }

        if (!itemCode || itemCode === '타입명' || itemCode.includes('재고') || itemCode.includes('용도') || itemCode.includes('총')) continue;
        if (!itemCode.match(/^(mem-|net-|sto-|raid-|CPU-|GPU-)/)) continue;

        const totalQty = parseInt(r[sec.qtyOffset]) || 0;
        const inUseQty = parseInt(r[sec.qtyOffset + 1]) || 0;
        const spareQty = parseInt(r[sec.qtyOffset + 2]) || 0;

        let mfr = null, model = null, capacity = null, spec = null;
        const refMap = { memory: memRef, network: netRef, disk: diskRef, raid: raidRef, cpu: cpuRef, gpu: gpuRef };
        const ref = refMap[sec.type] ? refMap[sec.type][itemCode] : null;
        if (ref) {
          mfr = ref.manufacturer; model = ref.model; capacity = ref.capacity; spec = ref.spec || null;
        }

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
} else {
  console.log('  Reference sheet not found!');
}

// ============================================================
// Step 3: Import Sheet 1 → equipment_usage_logs
// ============================================================
console.log('\n=== Importing Equipment Usage Logs (입출고관리) ===');
const logSheetName = wb.SheetNames.find(n => n.includes('입출고관리'));
let usageLogCount = 0;
let statusCounts = { '입고': 0, '사용중': 0, '반납완료': 0 };

if (!logSheetName) {
  console.error('입출고관리 sheet not found!');
  process.exit(1);
}

const logSheet = XLSX.utils.sheet_to_json(wb.Sheets[logSheetName], { header: 1, defval: '' });
console.log(`  Sheet "${logSheetName}" has ${logSheet.length} rows`);

// Detect header row - look for '사용날짜' or '관리번호'
let headerRow = -1;
for (let i = 0; i < Math.min(5, logSheet.length); i++) {
  const row = logSheet[i];
  const joined = row.map(c => String(c)).join('|');
  if (joined.includes('사용날짜') || joined.includes('관리번호') || joined.includes('모델명')) {
    headerRow = i;
    break;
  }
}
if (headerRow === -1) headerRow = 1; // default: row 1 is header, data from 2

console.log(`  Header at row ${headerRow}, data starts at row ${headerRow + 1}`);

// Print first few header cells for debugging
const hdr = logSheet[headerRow] || [];
console.log(`  Header columns (first 10): ${hdr.slice(0, 10).map((c, i) => `[${i}]=${String(c).substring(0, 20)}`).join(', ')}`);

// Map columns by header text
const colMap = {};
hdr.forEach((cell, i) => {
  const name = String(cell).trim();
  if (name) colMap[name] = i;
});
console.log(`  Column map keys: ${Object.keys(colMap).join(', ')}`);

// Column mapping with fallback positions based on typical 입출고관리 layout
// Col 0: 사용날짜, 1: 입고/반입일자, 2: 자산번호, 3: 관리번호, 4: 모델명
// Col 5: 사용자, 6: 시험명, 7: 상세시험명
// Col 8: 접속정보(root), 9: 접속정보(기타), 10: 접속정보(기타2)
// Col 11: IP(1), 12: IP(2), 13: IP(3), 14: IP(4), 15: BMC, 16: IB(1), 17: IB(2)
// Col 18: Room, 19: Rack, 20: Unit
// Col 21: CPU(타입), 22: CPU(수량)
// Col 23: MEM1(타입), 24: MEM1(수량), 25: MEM2(타입), 26: MEM2(수량)
// Col 27: Disk1(부품명), 28: Disk1(수량), 29: Disk2(부품명), 30: Disk2(수량)
// Col 31: Disk3(부품명), 32: Disk3(수량), 33: Disk4(부품명), 34: Disk4(수량)
// Col 35: NIC1(타입), 36: NIC1(수량), 37: NIC2(타입), 38: NIC2(수량)
// Col 39: NIC3(타입), 40: NIC3(수량), 41: NIC4(타입), 42: NIC4(수량)
// Col 43: RAID(타입), 44: RAID(수량)
// Col 45: GPU1(타입), 46: GPU1(수량), 47: GPU2(타입), 48: GPU2(수량)
// Col 49: OS
// Col 50: 기타사항/비고
// Col 51 or 52: 상태

function getCol(name, fallback) {
  if (colMap[name] !== undefined) return colMap[name];
  return fallback;
}

// Try to detect the status column
let statusCol = -1;
for (let i = 50; i < 56; i++) {
  if (i < hdr.length) {
    const val = String(hdr[i]).trim();
    if (val.includes('상태') || val === '비고' || val === '') {
      // Check if the data column has status values
      const testRow = logSheet[headerRow + 1];
      if (testRow) {
        const testVal = String(testRow[i] || '').trim();
        if (testVal === '입고' || testVal === '사용중' || testVal === '반납완료') {
          statusCol = i;
          break;
        }
      }
    }
  }
}
// Broader search for status column
if (statusCol === -1) {
  for (let i = hdr.length - 1; i >= 45; i--) {
    for (let r = headerRow + 1; r < Math.min(headerRow + 5, logSheet.length); r++) {
      const testVal = String(logSheet[r][i] || '').trim();
      if (testVal === '입고' || testVal === '사용중' || testVal === '반납완료') {
        statusCol = i;
        break;
      }
    }
    if (statusCol !== -1) break;
  }
}
console.log(`  Status column detected at: ${statusCol}`);

const usageLogStmt = db.prepare(`
  INSERT INTO equipment_usage_logs (
    usage_date, return_date, asset_number, management_number, model_name,
    user_name, test_name, test_detail,
    credential_root, credential_etc1, credential_etc2,
    ip1, ip2, ip3, ip4, bmc, ib1, ib2,
    room, rack, unit,
    cpu_type, cpu_num, mem1_type, mem1_num, mem2_type, mem2_num,
    disk1_part, disk1_num, disk2_part, disk2_num, disk3_part, disk3_num, disk4_part, disk4_num,
    nic1_type, nic1_num, nic2_type, nic2_num, nic3_type, nic3_num, nic4_type, nic4_num,
    raid_type, raid_num, gpu1_type, gpu1_num, gpu2_type, gpu2_num,
    os, notes, status
  ) VALUES (
    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
  )
`);

const importUsageLogs = db.transaction(() => {
  for (let i = headerRow + 1; i < logSheet.length; i++) {
    const r = logSheet[i];

    // Determine status
    let status = statusCol >= 0 ? String(r[statusCol] || '').trim() : '';
    if (!status) {
      // Try common status column positions
      for (let c = 50; c < 56 && c < r.length; c++) {
        const v = String(r[c] || '').trim();
        if (v === '입고' || v === '사용중' || v === '반납완료') { status = v; break; }
      }
    }
    if (status !== '입고' && status !== '사용중' && status !== '반납완료') continue;

    const mgmtNum = String(r[3] || '').trim();
    const modelName = String(r[4] || '').trim();
    if (!mgmtNum && !modelName) continue;

    const usageDate = excelDateToStr(r[0]);
    const returnDate = excelDateToStr(r[1]);
    const assetNumber = String(r[2] || '').trim() || null;
    const userName = String(r[5] || '').trim() || null;
    const testName = String(r[6] || '').trim() || null;
    const testDetail = String(r[7] || '').trim() || null;
    const credRoot = String(r[8] || '').trim() || null;
    const credEtc1 = String(r[9] || '').trim() || null;
    const credEtc2 = String(r[10] || '').trim() || null;
    const ip1 = String(r[11] || '').trim() || null;
    const ip2 = String(r[12] || '').trim() || null;
    const ip3 = String(r[13] || '').trim() || null;
    const ip4 = String(r[14] || '').trim() || null;
    const bmc = String(r[15] || '').trim() || null;
    const ib1 = String(r[16] || '').trim() || null;
    const ib2 = String(r[17] || '').trim() || null;
    const room = String(r[18] || '').trim() || null;
    const rack = String(r[19] || '').trim() || null;
    const unit = String(r[20] || '').trim() || null;

    const cpuType = String(r[21] || '').trim() || null;
    const cpuNum = parseInt(r[22]) || null;
    const mem1Type = String(r[23] || '').trim() || null;
    const mem1Num = parseInt(r[24]) || null;
    const mem2Type = String(r[25] || '').trim() || null;
    const mem2Num = parseInt(r[26]) || null;

    const disk1Part = String(r[27] || '').trim() || null;
    const disk1Num = parseInt(r[28]) || null;
    const disk2Part = String(r[29] || '').trim() || null;
    const disk2Num = parseInt(r[30]) || null;
    const disk3Part = String(r[31] || '').trim() || null;
    const disk3Num = parseInt(r[32]) || null;
    const disk4Part = String(r[33] || '').trim() || null;
    const disk4Num = parseInt(r[34]) || null;

    const nic1Type = String(r[35] || '').trim() || null;
    const nic1Num = parseInt(r[36]) || null;
    const nic2Type = String(r[37] || '').trim() || null;
    const nic2Num = parseInt(r[38]) || null;
    const nic3Type = String(r[39] || '').trim() || null;
    const nic3Num = parseInt(r[40]) || null;
    const nic4Type = String(r[41] || '').trim() || null;
    const nic4Num = parseInt(r[42]) || null;

    const raidType = String(r[43] || '').trim() || null;
    const raidNum = parseInt(r[44]) || null;
    const gpu1Type = String(r[45] || '').trim() || null;
    const gpu1Num = parseInt(r[46]) || null;
    const gpu2Type = String(r[47] || '').trim() || null;
    const gpu2Num = parseInt(r[48]) || null;

    const os = String(r[49] || '').trim() || null;
    const notes = String(r[50] || '').trim() || null;

    try {
      usageLogStmt.run(
        usageDate, returnDate, assetNumber, mgmtNum || null, modelName || null,
        userName, testName, testDetail,
        credRoot, credEtc1, credEtc2,
        ip1, ip2, ip3, ip4, bmc, ib1, ib2,
        room, rack, unit,
        cpuType, cpuNum, mem1Type, mem1Num, mem2Type, mem2Num,
        disk1Part, disk1Num, disk2Part, disk2Num, disk3Part, disk3Num, disk4Part, disk4Num,
        nic1Type, nic1Num, nic2Type, nic2Num, nic3Type, nic3Num, nic4Type, nic4Num,
        raidType, raidNum, gpu1Type, gpu1Num, gpu2Type, gpu2Num,
        os, notes, status
      );
      usageLogCount++;
      statusCounts[status] = (statusCounts[status] || 0) + 1;
    } catch (err) {
      console.error(`  Error usage log row ${i}: ${err.message}`);
    }
  }
});
importUsageLogs();
console.log(`  Imported ${usageLogCount} usage log entries`);
console.log(`  Status breakdown: 입고=${statusCounts['입고']}, 사용중=${statusCounts['사용중']}, 반납완료=${statusCounts['반납완료']}`);

// ============================================================
// Step 4: Derive assets from latest usage entries
// ============================================================
console.log('\n=== Deriving assets from usage logs ===');

// Get all unique management numbers and their latest entry
const mgmtGroups = db.prepare(`
  SELECT management_number, id, model_name, asset_number, user_name,
    test_name, test_detail, credential_root, credential_etc1, credential_etc2,
    ip1, ip2, ip3, ip4, bmc, ib1, ib2, room, rack, unit,
    cpu_type, cpu_num, mem1_type, mem1_num, mem2_type, mem2_num,
    disk1_part, disk1_num, disk2_part, disk2_num, disk3_part, disk3_num, disk4_part, disk4_num,
    nic1_type, nic1_num, nic2_type, nic2_num, nic3_type, nic3_num, nic4_type, nic4_num,
    raid_type, raid_num, gpu1_type, gpu1_num, gpu2_type, gpu2_num,
    os, notes, status, usage_date
  FROM equipment_usage_logs
  WHERE management_number IS NOT NULL AND management_number != ''
  AND id IN (
    SELECT MAX(id) FROM equipment_usage_logs
    WHERE management_number IS NOT NULL AND management_number != ''
    GROUP BY management_number
  )
  ORDER BY management_number
`).all();

console.log(`  Found ${mgmtGroups.length} unique management numbers`);

const assetStmt = db.prepare(`
  INSERT INTO assets (asset_number, management_number, asset_type, ownership, model_name,
    rack_id, rack_unit_start, rack_unit_size, ip_address, ssh_user, ssh_password,
    assigned_user, purpose, status, notes, room_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const ipStmt = db.prepare(`
  INSERT INTO asset_ips (asset_id, ip_address, ip_type, description) VALUES (?, ?, ?, ?)
`);

const credStmt = db.prepare(`
  INSERT INTO asset_credentials (asset_id, username, password, credential_type, description) VALUES (?, ?, ?, ?, ?)
`);

const moduleStmt = db.prepare(`
  INSERT INTO computing_modules (asset_id, module_type, model, manufacturer, capacity, count, specification)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

let assetCount = 0;
let ipCount = 0;
let credCount = 0;
let moduleCount = 0;
const usedAssetNumbers = new Set();

const deriveAssets = db.transaction(() => {
  for (const entry of mgmtGroups) {
    const mgmt = entry.management_number;
    const assetType = determineAssetType(mgmt, entry.model_name || '');

    // Determine status for asset
    let assetStatus = 'active';
    if (entry.status === '반납완료') assetStatus = 'decommissioned';
    else if (entry.status === '입고') assetStatus = 'inactive';

    // Room and Rack
    const roomId = getOrCreateRoom(entry.room);
    const rackId = roomId ? getOrCreateRack(roomId, entry.rack) : null;
    const { start: unitStart, size: unitSize } = parseUnit(entry.unit);

    // Primary IP
    const primaryIp = cleanIp(entry.ip1) || cleanIp(entry.ip2) || null;

    // Credentials
    const rootCred = parseCredentials(entry.credential_root);

    // Asset number dedup
    let assetNum = entry.asset_number;
    if (assetNum && assetNum !== '-') {
      if (usedAssetNumbers.has(assetNum)) {
        assetNum = assetNum + '_' + entry.id;
      }
      usedAssetNumbers.add(assetNum);
    } else {
      assetNum = null;
    }

    // Purpose from test info
    const tn = (entry.test_name || '').trim();
    const td = (entry.test_detail || '').trim();
    const purpose = (tn && td && td !== '-' && td !== tn) ? tn + '(' + td + ')' : (tn && tn !== '-' ? tn : (td && td !== '-' ? td : null));
    const notes = [entry.os ? `OS: ${entry.os}` : '', entry.notes || ''].filter(Boolean).join('; ') || null;

    try {
      const result = assetStmt.run(
        assetNum, mgmt, assetType, 'company', entry.model_name || null,
        rackId, unitStart, unitSize || 1,
        primaryIp, rootCred.user, rootCred.password,
        entry.user_name || null, purpose, assetStatus, notes, roomId
      );
      const assetId = result.lastInsertRowid;
      assetCount++;

      // Insert IPs
      const ips = [
        { addr: cleanIp(entry.ip1), type: 'management', desc: 'IP(1)' },
        { addr: cleanIp(entry.ip2), type: 'management', desc: 'IP(2)' },
        { addr: cleanIp(entry.ip3), type: 'management', desc: 'IP(3)' },
        { addr: cleanIp(entry.ip4), type: 'management', desc: 'IP(4)' },
        { addr: cleanIp(entry.bmc), type: 'bmc', desc: 'BMC' },
        { addr: cleanIp(entry.ib1), type: 'ib', desc: 'IB(1)' },
        { addr: cleanIp(entry.ib2), type: 'ib', desc: 'IB(2)' }
      ];
      for (const ip of ips) {
        if (ip.addr) {
          ipStmt.run(assetId, ip.addr, ip.type, ip.desc);
          ipCount++;
        }
      }

      // Insert credentials
      const creds = [
        { ...rootCred, type: 'root', desc: 'root 계정' },
        { ...parseCredentials(entry.credential_etc1), type: 'user', desc: '기타 계정' },
        { ...parseCredentials(entry.credential_etc2), type: 'user', desc: '기타 계정 2' }
      ];
      for (const cred of creds) {
        if (cred.user) {
          credStmt.run(assetId, cred.user, cred.password || null, cred.type, cred.desc);
          credCount++;
        }
      }

      // Insert computing modules
      const componentPairs = [
        { type: 'cpu', code: entry.cpu_type, num: entry.cpu_num, ref: cpuRef },
        { type: 'memory', code: entry.mem1_type, num: entry.mem1_num, ref: memRef },
        { type: 'memory', code: entry.mem2_type, num: entry.mem2_num, ref: memRef },
        { type: 'disk', code: entry.disk1_part, num: entry.disk1_num, ref: diskRef },
        { type: 'disk', code: entry.disk2_part, num: entry.disk2_num, ref: diskRef },
        { type: 'disk', code: entry.disk3_part, num: entry.disk3_num, ref: diskRef },
        { type: 'disk', code: entry.disk4_part, num: entry.disk4_num, ref: diskRef },
        { type: 'network', code: entry.nic1_type, num: entry.nic1_num, ref: netRef },
        { type: 'network', code: entry.nic2_type, num: entry.nic2_num, ref: netRef },
        { type: 'network', code: entry.nic3_type, num: entry.nic3_num, ref: netRef },
        { type: 'network', code: entry.nic4_type, num: entry.nic4_num, ref: netRef },
        { type: 'raid', code: entry.raid_type, num: entry.raid_num, ref: raidRef },
        { type: 'gpu', code: entry.gpu1_type, num: entry.gpu1_num, ref: gpuRef },
        { type: 'gpu', code: entry.gpu2_type, num: entry.gpu2_num, ref: gpuRef }
      ];

      for (const comp of componentPairs) {
        const code = comp.code ? String(comp.code).trim() : '';
        const num = parseInt(comp.num) || 0;
        if (!code || code === '-' || num <= 0) continue;

        const refData = comp.ref[code];
        if (refData) {
          moduleStmt.run(assetId, comp.type, refData.model, refData.manufacturer, refData.capacity, num, code);
        } else {
          moduleStmt.run(assetId, comp.type, code, null, null, num, null);
        }
        moduleCount++;
      }
    } catch (err) {
      console.error(`  Error deriving asset for ${mgmt}: ${err.message}`);
    }
  }
});
deriveAssets();
console.log(`  Created ${assetCount} assets, ${ipCount} IPs, ${credCount} credentials, ${moduleCount} modules`);

// ============================================================
// Summary
// ============================================================
const totalUsageLogs = db.prepare('SELECT COUNT(*) as c FROM equipment_usage_logs').get().c;
const totalAssets = db.prepare('SELECT COUNT(*) as c FROM assets').get().c;
const totalModules = db.prepare('SELECT COUNT(*) as c FROM computing_modules').get().c;
const totalRooms = db.prepare('SELECT COUNT(*) as c FROM server_rooms').get().c;
const totalRacks = db.prepare('SELECT COUNT(*) as c FROM racks').get().c;
const totalIps = db.prepare('SELECT COUNT(*) as c FROM asset_ips').get().c;
const totalCreds = db.prepare('SELECT COUNT(*) as c FROM asset_credentials').get().c;
const totalModInv = db.prepare('SELECT COUNT(*) as c FROM module_inventory').get().c;

console.log('\n=== Import Summary ===');
console.log(`Equipment Usage Logs: ${totalUsageLogs}`);
console.log(`  입고: ${statusCounts['입고']}, 사용중: ${statusCounts['사용중']}, 반납완료: ${statusCounts['반납완료']}`);
console.log(`Module Inventory: ${totalModInv}`);
console.log(`Assets (derived): ${totalAssets}`);
console.log(`Computing Modules: ${totalModules}`);
console.log(`Asset IPs: ${totalIps}`);
console.log(`Asset Credentials: ${totalCreds}`);
console.log(`Server Rooms: ${totalRooms}`);
console.log(`Racks: ${totalRacks}`);

// Show rooms and racks
const rooms = db.prepare('SELECT * FROM server_rooms ORDER BY name').all();
rooms.forEach(room => {
  const racks = db.prepare('SELECT name FROM racks WHERE room_id = ? ORDER BY name').all(room.id);
  console.log(`  ${room.name} [${room.location_type || 'server_room'}]: ${racks.map(r => r.name).join(', ') || '(no racks)'}`);
});

db.close();
console.log('\nDone!');
