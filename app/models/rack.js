const { getDb } = require('../config/database');

const Rack = {
  findAll() {
    return getDb().prepare(`
      SELECT r.*, sr.name as room_name
      FROM racks r
      JOIN server_rooms sr ON r.room_id = sr.id
      ORDER BY sr.name, r.name
    `).all();
  },

  findById(id) {
    return getDb().prepare(`
      SELECT r.*, sr.name as room_name,
        la.asset_number as linked_asset_number,
        la.model_name as linked_model_name,
        la.serial_number as linked_serial_number
      FROM racks r
      JOIN server_rooms sr ON r.room_id = sr.id
      LEFT JOIN assets la ON r.linked_asset_id = la.id
      WHERE r.id = ?
    `).get(id);
  },

  findByLinkedAsset(assetId) {
    return getDb().prepare(`
      SELECT r.*, sr.name as room_name
      FROM racks r
      JOIN server_rooms sr ON r.room_id = sr.id
      WHERE r.linked_asset_id = ?
    `).get(assetId);
  },

  findByRoom(roomId) {
    const racks = getDb().prepare(`
      SELECT r.*,
        (SELECT COUNT(*) FROM assets a
          WHERE a.rack_id = r.id
          AND a.parent_asset_id IS NULL
          AND a.rack_unit_start IS NOT NULL
          AND a.status NOT IN ('inactive','returned','decommissioned')
        ) as asset_count
      FROM racks r
      WHERE r.room_id = ?
      ORDER BY r.row_position, r.col_position
    `).all(roomId);

    // Calculate used_units per rack considering blade (half-width) assets
    // Two blade assets sharing the same U positions should only count once
    const stmt = getDb().prepare(
      "SELECT rack_unit_start, rack_unit_size, blade_slot FROM assets WHERE rack_id = ? AND parent_asset_id IS NULL AND rack_unit_start IS NOT NULL AND status NOT IN ('inactive','returned','decommissioned')"
    );
    racks.forEach(rack => {
      const assets = stmt.all(rack.id);
      const occupiedU = new Set();
      assets.forEach(a => {
        const startU = Math.floor((a.rack_unit_start - 1) / 3) + 1;
        const sizeU = Math.ceil((a.rack_unit_size || 3) / 3);
        for (let u = startU; u < startU + sizeU; u++) {
          occupiedU.add(u);
        }
      });
      rack.used_units = occupiedU.size;
    });

    return racks;
  },

  create(data) {
    let row = parseInt(data.row_position) || 1;
    let col = parseInt(data.col_position) || 1;

    // Auto-find next empty position if the target is occupied
    if (data.room_id) {
      const existing = getDb().prepare(
        'SELECT row_position, col_position FROM racks WHERE room_id = ?'
      ).all(data.room_id);
      const occupied = new Set(existing.map(r => r.row_position + ':' + r.col_position));
      if (occupied.has(row + ':' + col)) {
        for (let r = 1; r <= 10; r++) {
          let found = false;
          for (let c = 1; c <= 12; c++) {
            if (!occupied.has(r + ':' + c)) {
              row = r; col = c; found = true; break;
            }
          }
          if (found) break;
        }
      }
    }

    const stmt = getDb().prepare(`
      INSERT INTO racks (room_id, name, total_units, row_position, col_position, description, rack_type, linked_asset_id, switch_slots)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      data.room_id, data.name, data.total_units || 42,
      row, col, data.description, data.rack_type || 'standard',
      data.linked_asset_id || null, data.switch_slots || 0
    );
    return result.lastInsertRowid;
  },

  update(id, data) {
    const stmt = getDb().prepare(`
      UPDATE racks SET room_id=?, name=?, total_units=?, row_position=?, col_position=?,
        description=?, rack_type=?, switch_slots=?, updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `);
    return stmt.run(
      data.room_id, data.name, data.total_units || 42,
      data.row_position || 1, data.col_position || 1, data.description,
      data.rack_type || 'standard', data.switch_slots || 0, id
    );
  },

  updatePosition(id, row, col) {
    return getDb().prepare(
      'UPDATE racks SET row_position=?, col_position=?, updated_at=CURRENT_TIMESTAMP WHERE id=?'
    ).run(row, col, id);
  },

  delete(id) {
    return getDb().prepare('DELETE FROM racks WHERE id = ?').run(id);
  },

  getRoomUsageStats() {
    const db = getDb();
    const rooms = db.prepare(
      `SELECT sr.id, sr.name as room_name, SUM(r.total_units) as total_units
       FROM racks r JOIN server_rooms sr ON r.room_id = sr.id
       WHERE sr.location_type = 'server_room'
       GROUP BY sr.id ORDER BY sr.name`
    ).all();

    const stmt = db.prepare(
      "SELECT a.rack_unit_start, a.rack_unit_size, a.blade_slot FROM assets a JOIN racks r ON a.rack_id = r.id WHERE r.room_id = ? AND a.parent_asset_id IS NULL AND a.rack_unit_start IS NOT NULL AND a.status NOT IN ('inactive','returned','decommissioned')"
    );
    rooms.forEach(room => {
      const assets = stmt.all(room.id);
      const occupiedU = new Set();
      assets.forEach(a => {
        const startU = Math.floor((a.rack_unit_start - 1) / 3) + 1;
        const sizeU = Math.ceil((a.rack_unit_size || 3) / 3);
        for (let u = startU; u < startU + sizeU; u++) {
          occupiedU.add(a.rack_unit_start + ':' + u); // rack-scoped uniqueness
        }
      });
      room.used_units = occupiedU.size;
    });
    return rooms;
  },

  getUsageStats() {
    const db = getDb();
    const base = db.prepare('SELECT COUNT(*) as total_racks, SUM(total_units) as total_units FROM racks').get();
    const assets = db.prepare(
      "SELECT rack_id, rack_unit_start, rack_unit_size, blade_slot FROM assets WHERE rack_id IS NOT NULL AND parent_asset_id IS NULL AND rack_unit_start IS NOT NULL AND status NOT IN ('inactive','returned','decommissioned')"
    ).all();
    // Count unique U positions per rack
    const rackUMap = {};
    assets.forEach(a => {
      if (!rackUMap[a.rack_id]) rackUMap[a.rack_id] = new Set();
      const startU = Math.floor((a.rack_unit_start - 1) / 3) + 1;
      const sizeU = Math.ceil((a.rack_unit_size || 3) / 3);
      for (let u = startU; u < startU + sizeU; u++) {
        rackUMap[a.rack_id].add(u);
      }
    });
    let usedUnits = 0;
    Object.values(rackUMap).forEach(s => { usedUnits += s.size; });
    base.used_units = usedUnits;
    return base;
  }
};

module.exports = Rack;
