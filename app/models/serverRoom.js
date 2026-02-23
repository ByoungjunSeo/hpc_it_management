const { getDb } = require('../config/database');

const ServerRoom = {
  findAll(locationType) {
    if (locationType) {
      return getDb().prepare(`
        SELECT sr.*,
          (SELECT COUNT(*) FROM racks r WHERE r.room_id = sr.id) as rack_count
        FROM server_rooms sr
        WHERE sr.location_type = ?
        ORDER BY sr.name
      `).all(locationType);
    }
    return getDb().prepare(`
      SELECT sr.*,
        (SELECT COUNT(*) FROM racks r WHERE r.room_id = sr.id) as rack_count
      FROM server_rooms sr
      ORDER BY sr.name
    `).all();
  },

  findById(id) {
    return getDb().prepare('SELECT * FROM server_rooms WHERE id = ?').get(id);
  },

  findByName(name, locationType) {
    if (locationType) {
      return getDb().prepare('SELECT * FROM server_rooms WHERE name = ? AND location_type = ?').get(name, locationType);
    }
    return getDb().prepare('SELECT * FROM server_rooms WHERE name = ?').get(name);
  },

  create(data) {
    const stmt = getDb().prepare(
      'INSERT INTO server_rooms (name, location, description, location_type) VALUES (?, ?, ?, ?)'
    );
    const result = stmt.run(data.name, data.location, data.description, data.location_type || 'server_room');
    return result.lastInsertRowid;
  },

  update(id, data) {
    const stmt = getDb().prepare(
      'UPDATE server_rooms SET name=?, location=?, description=?, location_type=?, updated_at=CURRENT_TIMESTAMP WHERE id=?'
    );
    return stmt.run(data.name, data.location, data.description, data.location_type || 'server_room', id);
  },

  delete(id) {
    return getDb().prepare('DELETE FROM server_rooms WHERE id = ?').run(id);
  }
};

module.exports = ServerRoom;
