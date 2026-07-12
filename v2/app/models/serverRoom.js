const { pool } = require('../config/database');
const { fixRowDates } = require('../utils/dateFix');

// B-4d-9 Date 직렬화 스윕
function fixDates(row) {
  return fixRowDates(row, [], ['created_at', 'updated_at']);
}

const ServerRoom = {
  async findAll(locationType) {
    if (locationType) {
      const { rows } = await pool.query(
        `SELECT sr.*,
          (SELECT COUNT(*) FROM racks r WHERE r.room_id = sr.id) as rack_count
         FROM server_rooms sr
         WHERE sr.location_type = $1
         ORDER BY sr.name`, [locationType]
      );
      return rows.map(fixDates);
    }
    const { rows } = await pool.query(
      `SELECT sr.*,
        (SELECT COUNT(*) FROM racks r WHERE r.room_id = sr.id) as rack_count
       FROM server_rooms sr
       ORDER BY sr.name`
    );
    return rows.map(fixDates);
  },

  async findById(id) {
    const { rows } = await pool.query('SELECT * FROM server_rooms WHERE id = $1', [id]);
    return fixDates(rows[0] || null);
  },

  async findByName(name, locationType) {
    if (locationType) {
      const { rows } = await pool.query(
        'SELECT * FROM server_rooms WHERE name = $1 AND location_type = $2', [name, locationType]
      );
      return rows[0];
    }
    const { rows } = await pool.query('SELECT * FROM server_rooms WHERE name = $1', [name]);
    return rows[0];
  },

  // BL-3: 정규화(trim+대소문자 무시) 중복 조회 — location_type별 분리 유지.
  // excludeId는 개명(수정) 시 자기 자신 제외용.
  async findByNameNormalized(name, locationType, excludeId) {
    let sql = `SELECT * FROM server_rooms
               WHERE lower(trim(name)) = lower(trim($1)) AND location_type = $2`;
    const params = [name, locationType || 'server_room'];
    if (excludeId) {
      sql += ' AND id != $3';
      params.push(excludeId);
    }
    const { rows } = await pool.query(sql, params);
    return rows[0];
  },

  async create(data) {
    const { rows } = await pool.query(
      'INSERT INTO server_rooms (name, location, description, location_type) VALUES ($1, $2, $3, $4) RETURNING id',
      [data.name ? data.name.trim() : data.name, data.location, data.description, data.location_type || 'server_room']
    );
    return rows[0].id;
  },

  async update(id, data) {
    return pool.query(
      'UPDATE server_rooms SET name=$1, location=$2, description=$3, location_type=$4, updated_at=NOW() WHERE id=$5',
      [data.name ? data.name.trim() : data.name, data.location, data.description, data.location_type || 'server_room', id]
    );
  },

  async delete(id) {
    return pool.query('DELETE FROM server_rooms WHERE id = $1', [id]);
  }
};

module.exports = ServerRoom;
