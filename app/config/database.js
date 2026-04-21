const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '..', 'data', 'it_assets.db');
const SCHEMA_PATH = path.join(__dirname, '..', 'db', 'schema.sql');

let db;

function getDb() {
  if (!db) {
    const dataDir = path.dirname(DB_PATH);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    initSchema();
    runMigrations();
  }
  return db;
}

function initSchema() {
  const schema = fs.readFileSync(SCHEMA_PATH, 'utf-8');
  db.exec(schema);
}

// Sync equipment_usage_logs data into asset_ips and asset_credentials
function syncUsageLogsToAssets(db) {
  try {
    // Get latest usage log per management_number
    const logs = db.prepare(`
      SELECT e.management_number, e.ip1, e.ip2, e.ip3, e.ip4, e.bmc, e.ib1, e.ib2,
        e.credential_root, e.credential_etc1, e.credential_etc2, e.credentials_json,
        a.id as asset_id
      FROM equipment_usage_logs e
      JOIN assets a ON a.management_number = e.management_number
      WHERE e.id IN (
        SELECT MAX(e2.id) FROM equipment_usage_logs e2
        WHERE e2.management_number = e.management_number
      )
    `).all();

    const checkIp = db.prepare('SELECT id FROM asset_ips WHERE asset_id = ? AND ip_address = ?');
    const insertIp = db.prepare('INSERT INTO asset_ips (asset_id, ip_address, ip_type) VALUES (?, ?, ?)');
    const checkCred = db.prepare('SELECT id FROM asset_credentials WHERE asset_id = ? AND credential_type = ? AND username = ?');
    const insertCred = db.prepare('INSERT INTO asset_credentials (asset_id, username, password, credential_type) VALUES (?, ?, ?, ?)');

    const syncTx = db.transaction(() => {
      for (const log of logs) {
        // Sync IPs
        const ipFields = [
          { val: log.ip1, type: 'management' }, { val: log.ip2, type: 'data' },
          { val: log.ip3, type: 'data' }, { val: log.ip4, type: 'data' },
          { val: log.bmc, type: 'bmc' }, { val: log.ib1, type: 'ib' }, { val: log.ib2, type: 'ib' }
        ];
        for (const f of ipFields) {
          if (f.val && f.val.trim()) {
            const ip = f.val.trim();
            if (!checkIp.get(log.asset_id, ip)) {
              insertIp.run(log.asset_id, ip, f.type);
            }
          }
        }

        // Sync credentials from credential_root, credential_etc1, credential_etc2
        const credFields = [
          { val: log.credential_root, type: 'root' },
          { val: log.credential_etc1, type: 'user' },
          { val: log.credential_etc2, type: 'user' }
        ];
        for (const c of credFields) {
          if (c.val && c.val.trim() && c.val.trim() !== '-') {
            // Parse "user / pass" or "user/pass" format
            const parts = c.val.trim().split(/\s*\/\s*/);
            if (parts.length >= 2) {
              const username = parts[0].trim();
              const password = parts.slice(1).join('/').trim();
              if (username && !checkCred.get(log.asset_id, c.type, username)) {
                insertCred.run(log.asset_id, username, password, c.type);
              }
            }
          }
        }

        // Sync credentials from credentials_json
        if (log.credentials_json) {
          try {
            const creds = JSON.parse(log.credentials_json);
            if (Array.isArray(creds)) {
              for (const cr of creds) {
                if (cr.username && cr.username.trim() && cr.username.trim() !== '-') {
                  const credType = cr.type || 'root';
                  if (!checkCred.get(log.asset_id, credType, cr.username.trim())) {
                    insertCred.run(log.asset_id, cr.username.trim(), cr.password || '', credType);
                  }
                }
              }
            }
          } catch (e) { /* invalid JSON */ }
        }
      }
    });
    syncTx();
  } catch (e) {
    console.error('[syncUsageLogsToAssets] Error:', e.message);
  }
}

function runMigrations() {
  // Migration: add location_type column to server_rooms
  const columns = db.prepare("PRAGMA table_info(server_rooms)").all();
  const hasLocationType = columns.some(c => c.name === 'location_type');

  if (!hasLocationType) {
    db.exec("ALTER TABLE server_rooms ADD COLUMN location_type TEXT DEFAULT 'server_room'");

    // Set location_type for known office/storage rooms
    const officeNames = ['독립개발실3', '판교 사무실', 'AI캠퍼스(야탑)', '오픈랩'];
    const storageNames = ['장비실'];

    const updateStmt = db.prepare('UPDATE server_rooms SET location_type = ? WHERE name = ?');
    officeNames.forEach(name => updateStmt.run('office', name));
    storageNames.forEach(name => updateStmt.run('storage', name));
  }

  // Migration: add room_id column to assets
  const assetCols = db.prepare("PRAGMA table_info(assets)").all();
  if (!assetCols.some(c => c.name === 'room_id')) {
    db.exec("ALTER TABLE assets ADD COLUMN room_id INTEGER REFERENCES server_rooms(id)");
    db.exec("UPDATE assets SET room_id = (SELECT room_id FROM racks WHERE racks.id = assets.rack_id) WHERE rack_id IS NOT NULL");
  }

  // Migration: create initial admin account
  const adminExists = db.prepare("SELECT id FROM users WHERE username = 'admin'").get();
  if (!adminExists) {
    const User = require('../models/user');
    User.ensureAdmin();
  }

  // Migration: create test accounts (maint01, viewer01)
  const maint = db.prepare("SELECT id FROM users WHERE username = 'maint01'").get();
  if (!maint) {
    const User = require('../models/user');
    try { User.create({ username: 'maint01', password: 'qwe123', role: 'maintenance', display_name: '유지보수담당' }); } catch(e) {}
    try { User.create({ username: 'viewer01', password: 'qwe123', role: 'viewer', display_name: '조회전용' }); } catch(e) {}
  }

  // Migration: create equipment_usage_logs table
  const eqTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='equipment_usage_logs'").get();
  if (!eqTables) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS equipment_usage_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        usage_date DATE, return_date DATE,
        asset_number TEXT, management_number TEXT, model_name TEXT,
        user_name TEXT, test_name TEXT, test_detail TEXT,
        credential_root TEXT, credential_etc1 TEXT, credential_etc2 TEXT,
        ip1 TEXT, ip2 TEXT, ip3 TEXT, ip4 TEXT,
        bmc TEXT, ib1 TEXT, ib2 TEXT,
        room TEXT, rack TEXT, unit TEXT,
        cpu_type TEXT, cpu_num INTEGER,
        mem1_type TEXT, mem1_num INTEGER, mem2_type TEXT, mem2_num INTEGER,
        disk1_part TEXT, disk1_num INTEGER, disk2_part TEXT, disk2_num INTEGER,
        disk3_part TEXT, disk3_num INTEGER, disk4_part TEXT, disk4_num INTEGER,
        nic1_type TEXT, nic1_num INTEGER, nic2_type TEXT, nic2_num INTEGER,
        nic3_type TEXT, nic3_num INTEGER, nic4_type TEXT, nic4_num INTEGER,
        raid_type TEXT, raid_num INTEGER,
        gpu1_type TEXT, gpu1_num INTEGER, gpu2_type TEXT, gpu2_num INTEGER,
        os TEXT, notes TEXT,
        status TEXT DEFAULT '입고' CHECK(status IN ('입고','사용중','반납완료')),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_equip_usage_mgmt ON equipment_usage_logs(management_number);
      CREATE INDEX IF NOT EXISTS idx_equip_usage_status ON equipment_usage_logs(status);
      CREATE INDEX IF NOT EXISTS idx_equip_usage_date ON equipment_usage_logs(usage_date);
    `);
  }

  // Migration: add ownership column to equipment_usage_logs
  const eqCols = db.prepare("PRAGMA table_info(equipment_usage_logs)").all();
  if (!eqCols.some(c => c.name === 'ownership')) {
    db.exec("ALTER TABLE equipment_usage_logs ADD COLUMN ownership TEXT DEFAULT 'company'");
  }

  // Migration: add parent_asset_id column to assets (for blade chassis-node relationship)
  const assetCols2 = db.prepare("PRAGMA table_info(assets)").all();
  if (!assetCols2.some(c => c.name === 'parent_asset_id')) {
    db.exec("ALTER TABLE assets ADD COLUMN parent_asset_id INTEGER REFERENCES assets(id) ON DELETE CASCADE");
    db.exec("CREATE INDEX IF NOT EXISTS idx_assets_parent ON assets(parent_asset_id)");
  }

  // Migration: relax blade_slot CHECK constraint (allow any text, not just left/right)
  // SQLite can't alter CHECK constraints, but new column without constraint works
  // For existing DBs with the old constraint, blade_slot values beyond left/right
  // will work because SQLite doesn't enforce CHECK on ALTER-added columns.
  // New installs use the updated schema.sql without the CHECK.

  // Migration: add interface_type and speed columns to asset_ips
  const aipCols = db.prepare("PRAGMA table_info(asset_ips)").all();
  if (!aipCols.some(c => c.name === 'interface_type')) {
    db.exec("ALTER TABLE asset_ips ADD COLUMN interface_type TEXT DEFAULT NULL");
  }
  if (!aipCols.some(c => c.name === 'speed')) {
    db.exec("ALTER TABLE asset_ips ADD COLUMN speed TEXT DEFAULT NULL");
  }

  // Migration: add owner and owner_vendor_id columns to computing_modules
  const cmCols = db.prepare("PRAGMA table_info(computing_modules)").all();
  if (!cmCols.some(c => c.name === 'owner')) {
    db.exec("ALTER TABLE computing_modules ADD COLUMN owner TEXT DEFAULT 'company'");
  }
  if (!cmCols.some(c => c.name === 'owner_vendor_id')) {
    db.exec("ALTER TABLE computing_modules ADD COLUMN owner_vendor_id INTEGER REFERENCES vendor_info(id)");
  }
  if (!cmCols.some(c => c.name === 'is_onboard')) {
    db.exec("ALTER TABLE computing_modules ADD COLUMN is_onboard INTEGER DEFAULT 0");
  }

  // Migration: create module_transfer_logs table
  const mtlTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='module_transfer_logs'").get();
  if (!mtlTable) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS module_transfer_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        transfer_date DATE DEFAULT (date('now')),
        module_type TEXT NOT NULL,
        model TEXT,
        capacity TEXT,
        count INTEGER DEFAULT 1,
        owner TEXT DEFAULT 'company',
        owner_vendor_id INTEGER,
        from_asset_id INTEGER,
        from_asset_label TEXT,
        to_asset_id INTEGER,
        to_asset_label TEXT,
        reason TEXT,
        user_id INTEGER,
        username TEXT,
        notes TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_mtl_from_asset ON module_transfer_logs(from_asset_id);
      CREATE INDEX IF NOT EXISTS idx_mtl_to_asset ON module_transfer_logs(to_asset_id);
      CREATE INDEX IF NOT EXISTS idx_mtl_date ON module_transfer_logs(transfer_date);
    `);
  }

  // Migration: add asset_number column to module_inventory
  const miCols = db.prepare("PRAGMA table_info(module_inventory)").all();
  if (!miCols.some(c => c.name === 'asset_number')) {
    db.exec("ALTER TABLE module_inventory ADD COLUMN asset_number TEXT");
  }

  // Migration: create module_inventory_logs table
  const milTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='module_inventory_logs'").get();
  if (!milTable) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS module_inventory_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_code TEXT NOT NULL,
        event_type TEXT NOT NULL,
        quantity_change INTEGER DEFAULT 0,
        before_total INTEGER,
        after_total INTEGER,
        before_spare INTEGER,
        after_spare INTEGER,
        asset_id INTEGER,
        asset_label TEXT,
        from_asset_id INTEGER,
        from_asset_label TEXT,
        to_asset_id INTEGER,
        to_asset_label TEXT,
        asset_number TEXT,
        user_id INTEGER,
        username TEXT,
        notes TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_mil_item_code ON module_inventory_logs(item_code);
      CREATE INDEX IF NOT EXISTS idx_mil_created_at ON module_inventory_logs(created_at);
    `);
  }
  // Migration: ensure storage_quantity column exists and has correct values
  const miCols2 = db.prepare("PRAGMA table_info(module_inventory)").all();
  if (!miCols2.some(c => c.name === 'storage_quantity')) {
    db.exec("ALTER TABLE module_inventory ADD COLUMN storage_quantity INTEGER DEFAULT 0");
  }
  db.prepare(`
    UPDATE module_inventory
    SET storage_quantity = total_quantity
    WHERE storage_quantity IS NULL OR storage_quantity = 0
  `).run();

  // Migration: add rack_type column to racks
  const rackCols = db.prepare("PRAGMA table_info(racks)").all();
  if (!rackCols.some(c => c.name === 'rack_type')) {
    db.exec("ALTER TABLE racks ADD COLUMN rack_type TEXT DEFAULT 'standard'");
  }

  // Migration: widen asset_type CHECK to include immersion_tank, cdu, chiller
  const assetSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='assets'").get();
  if (assetSql && assetSql.sql && (!assetSql.sql.includes('immersion_tank') || !assetSql.sql.includes('chiller'))) {
    // SQLite can't ALTER CHECK constraints, so recreate the table
    // Temporarily disable foreign keys to prevent ON DELETE SET NULL during table swap
    db.pragma('foreign_keys = OFF');
    db.exec(`
      CREATE TABLE assets_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        asset_number TEXT,
        management_number TEXT,
        asset_type TEXT NOT NULL CHECK(asset_type IN ('server','switch','kvm','pdu','ups','storage','immersion_tank','cdu','chiller','other')),
        ownership TEXT NOT NULL DEFAULT 'company' CHECK(ownership IN ('company','vendor')),
        vendor_id INTEGER,
        model_name TEXT,
        manufacturer TEXT,
        serial_number TEXT,
        rack_id INTEGER,
        rack_unit_start INTEGER,
        rack_unit_size INTEGER DEFAULT 1,
        ip_address TEXT,
        ssh_port INTEGER DEFAULT 22,
        ssh_user TEXT DEFAULT 'root',
        ssh_password TEXT,
        assigned_user TEXT,
        purpose TEXT,
        status TEXT DEFAULT 'active' CHECK(status IN ('active','inactive','returned','maintenance','decommissioned')),
        purchase_date DATE,
        warranty_end DATE,
        notes TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        blade_slot TEXT,
        room_id INTEGER REFERENCES server_rooms(id),
        parent_asset_id INTEGER REFERENCES assets(id) ON DELETE CASCADE,
        shelf_size INTEGER DEFAULT 0,
        FOREIGN KEY (rack_id) REFERENCES racks(id) ON DELETE SET NULL,
        FOREIGN KEY (vendor_id) REFERENCES vendor_info(id) ON DELETE SET NULL
      );
    `);
    // Copy data (use common columns from existing table)
    const existingCols = db.prepare("PRAGMA table_info(assets)").all().map(c => c.name);
    const newCols = db.prepare("PRAGMA table_info(assets_new)").all().map(c => c.name);
    const commonCols = existingCols.filter(c => newCols.includes(c));
    const colList = commonCols.join(', ');
    db.exec(`INSERT INTO assets_new (${colList}) SELECT ${colList} FROM assets`);
    db.exec('DROP TABLE assets');
    db.exec('ALTER TABLE assets_new RENAME TO assets');
    // Recreate indexes
    db.exec('CREATE INDEX IF NOT EXISTS idx_assets_rack ON assets(rack_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_assets_type ON assets(asset_type)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_assets_ownership ON assets(ownership)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_assets_parent ON assets(parent_asset_id)');
    // Re-enable foreign keys
    db.pragma('foreign_keys = ON');
  }

  // Migration: add linked_asset_id and switch_slots columns to racks
  const rackCols2 = db.prepare("PRAGMA table_info(racks)").all();
  if (!rackCols2.some(c => c.name === 'linked_asset_id')) {
    db.exec("ALTER TABLE racks ADD COLUMN linked_asset_id INTEGER REFERENCES assets(id) ON DELETE SET NULL");
    db.exec("CREATE INDEX IF NOT EXISTS idx_racks_linked_asset ON racks(linked_asset_id)");
  }
  if (!rackCols2.some(c => c.name === 'switch_slots')) {
    db.exec("ALTER TABLE racks ADD COLUMN switch_slots INTEGER DEFAULT 0");
  }

  // ── 앱 시작 시 equipment_usage_logs → asset_ips, asset_credentials 동기화 ──
  syncUsageLogsToAssets(db);

  // 앱 시작 시 computing_modules 기반으로 재고 재계산
  // 1) specification 직접 매칭
  const directRows = db.prepare(`
    SELECT cm.specification as item_code, SUM(cm.count) as total_count
    FROM computing_modules cm
    JOIN assets a ON cm.asset_id = a.id
    WHERE cm.specification IS NOT NULL
      AND cm.specification != ''
      AND (cm.owner IS NULL OR cm.owner = 'company')
      AND a.status = 'active'
    GROUP BY cm.specification
  `).all();
  // 2) specification 비어있으면 module_type + model로 폴백 매칭
  const fallbackRows = db.prepare(`
    SELECT mi.item_code, SUM(cm.count) as total_count
    FROM computing_modules cm
    JOIN assets a ON cm.asset_id = a.id
    JOIN module_inventory mi ON mi.module_type = cm.module_type AND mi.model = cm.model
    WHERE (cm.specification IS NULL OR cm.specification = '')
      AND cm.model IS NOT NULL AND cm.model != ''
      AND (cm.owner IS NULL OR cm.owner = 'company')
      AND a.status = 'active'
    GROUP BY mi.item_code
  `).all();

  const usageMap = {};
  for (const row of directRows) {
    usageMap[row.item_code] = (usageMap[row.item_code] || 0) + row.total_count;
  }
  for (const row of fallbackRows) {
    usageMap[row.item_code] = (usageMap[row.item_code] || 0) + row.total_count;
  }

  db.prepare(`
    UPDATE module_inventory
    SET in_use_quantity = 0,
        storage_quantity = total_quantity,
        spare_quantity = total_quantity
  `).run();

  const recalcStmt = db.prepare(`
    UPDATE module_inventory
    SET in_use_quantity = ?,
        storage_quantity = MAX(0, total_quantity - ?),
        spare_quantity = MAX(0, total_quantity - ?),
        updated_at = CURRENT_TIMESTAMP
    WHERE item_code = ?
  `);
  for (const [code, count] of Object.entries(usageMap)) {
    recalcStmt.run(count, count, count, code);
  }
}

function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = { getDb, closeDb };
