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

  // Migration: add interface_type and speed columns to asset_ips
  const aipCols = db.prepare("PRAGMA table_info(asset_ips)").all();
  if (!aipCols.some(c => c.name === 'interface_type')) {
    db.exec("ALTER TABLE asset_ips ADD COLUMN interface_type TEXT DEFAULT NULL");
  }
  if (!aipCols.some(c => c.name === 'speed')) {
    db.exec("ALTER TABLE asset_ips ADD COLUMN speed TEXT DEFAULT NULL");
  }
}

function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = { getDb, closeDb };
