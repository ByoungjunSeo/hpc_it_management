const { pool } = require('../config/database');
const { fixRowDates } = require('../utils/dateFix');

// B-4d-9 Date 직렬화 스윕
function fixDates(row) {
  return fixRowDates(row, [], ['created_at', 'updated_at']);
}

const Rack = {
  async findByRoom(roomId) {
    const { rows: racks } = await pool.query(
      `SELECT r.*,
        (SELECT COUNT(*) FROM assets a
          WHERE a.rack_id = r.id
          AND a.parent_asset_id IS NULL
          AND a.rack_unit_start IS NOT NULL
          AND a.status NOT IN ('inactive','returned','decommissioned')
        ) as asset_count
       FROM racks r
       WHERE r.room_id = $1
       ORDER BY r.row_position, r.col_position`, [roomId]
    );

    // Calculate used_units per rack
    const { rows: allAssets } = await pool.query(
      `SELECT rack_id, rack_unit_start, rack_unit_size, blade_slot
       FROM assets
       WHERE rack_id = ANY($1::int[])
         AND parent_asset_id IS NULL AND rack_unit_start IS NOT NULL
         AND status NOT IN ('inactive','returned','decommissioned')`,
      [racks.map(r => r.id)]
    );

    const rackAssetMap = {};
    allAssets.forEach(a => {
      if (!rackAssetMap[a.rack_id]) rackAssetMap[a.rack_id] = [];
      rackAssetMap[a.rack_id].push(a);
    });

    racks.forEach(rack => {
      const assets = rackAssetMap[rack.id] || [];
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

  async create(data) {
    let row = parseInt(data.row_position) || 1;
    let col = parseInt(data.col_position) || 1;

    if (data.room_id) {
      const { rows: existing } = await pool.query(
        'SELECT row_position, col_position FROM racks WHERE room_id = $1', [data.room_id]
      );
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

    const { rows } = await pool.query(
      `INSERT INTO racks (room_id, name, total_units, row_position, col_position, description, rack_type, linked_asset_id, switch_slots)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [data.room_id, data.name, data.total_units || 42, row, col,
       data.description, data.rack_type || 'standard',
       data.linked_asset_id || null, data.switch_slots || 0]
    );
    return rows[0].id;
  },

  async findAll() {
    const { rows } = await pool.query(
      `SELECT r.*, sr.name as room_name
       FROM racks r
       LEFT JOIN server_rooms sr ON r.room_id = sr.id
       ORDER BY sr.name, r.name`
    );
    return rows.map(fixDates);
  },

  async findById(id) {
    const { rows } = await pool.query('SELECT * FROM racks WHERE id = $1', [id]);
    return fixDates(rows[0] || null);
  },

  async findByLinkedAsset(assetId) {
    const { rows } = await pool.query(
      `SELECT r.*, sr.name as room_name
       FROM racks r
       LEFT JOIN server_rooms sr ON r.room_id = sr.id
       WHERE r.linked_asset_id = $1`, [assetId]
    );
    return fixDates(rows[0] || null);
  },

  async update(id, data) {
    return pool.query(
      `UPDATE racks SET room_id=$1, name=$2, total_units=$3, row_position=$4, col_position=$5,
       description=$6, rack_type=$7, switch_slots=$8, updated_at=NOW()
       WHERE id=$9`,
      [data.room_id, data.name, data.total_units || 42,
       data.row_position || 1, data.col_position || 1,
       data.description || null, data.rack_type || 'standard',
       data.switch_slots || 0, id]
    );
  },

  async delete(id) {
    return pool.query('DELETE FROM racks WHERE id = $1', [id]);
  },

  async updatePosition(id, row, col) {
    return pool.query(
      'UPDATE racks SET row_position=$1, col_position=$2, updated_at=CURRENT_TIMESTAMP WHERE id=$3',
      [row, col, id]
    );
  },

  async getUsageStats() {
    const { rows: [base] } = await pool.query(
      'SELECT COUNT(*) as total_racks, COALESCE(SUM(total_units),0) as total_units FROM racks'
    );
    const { rows: assets } = await pool.query(
      `SELECT rack_id, rack_unit_start, rack_unit_size, blade_slot FROM assets
       WHERE rack_id IS NOT NULL AND parent_asset_id IS NULL AND rack_unit_start IS NOT NULL
       AND status NOT IN ('inactive','returned','decommissioned')`
    );
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
  },

  async getRoomUsageStats() {
    const { rows: rooms } = await pool.query(
      `SELECT sr.id, sr.name as room_name, COALESCE(SUM(r.total_units),0) as total_units
       FROM racks r JOIN server_rooms sr ON r.room_id = sr.id
       WHERE sr.location_type = 'server_room'
       GROUP BY sr.id ORDER BY sr.name`
    );
    if (rooms.length === 0) return rooms;

    const roomIds = rooms.map(r => r.id);
    const { rows: assets } = await pool.query(
      `SELECT a.rack_unit_start, a.rack_unit_size, a.blade_slot, r.room_id
       FROM assets a JOIN racks r ON a.rack_id = r.id
       WHERE r.room_id = ANY($1::int[])
         AND a.parent_asset_id IS NULL AND a.rack_unit_start IS NOT NULL
         AND a.status NOT IN ('inactive','returned','decommissioned')`,
      [roomIds]
    );

    const roomAssetMap = {};
    assets.forEach(a => {
      if (!roomAssetMap[a.room_id]) roomAssetMap[a.room_id] = new Set();
      const startU = Math.floor((a.rack_unit_start - 1) / 3) + 1;
      const sizeU = Math.ceil((a.rack_unit_size || 3) / 3);
      for (let u = startU; u < startU + sizeU; u++) {
        roomAssetMap[a.room_id].add(a.rack_unit_start + ':' + u);
      }
    });

    rooms.forEach(room => {
      room.used_units = roomAssetMap[room.id] ? roomAssetMap[room.id].size : 0;
    });
    return rooms;
  }
};

module.exports = Rack;
