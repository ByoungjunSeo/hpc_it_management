const { pool } = require('../config/database');

const Asset = {
  async findAll(filters = {}) {
    let sql = `
      SELECT a.*, r.name as rack_name,
        COALESCE(sr_direct.name, sr.name) as room_name,
        COALESCE(a.room_id, sr.id) as room_id,
        v.vendor_name
      FROM assets a
      LEFT JOIN racks r ON a.rack_id = r.id
      LEFT JOIN server_rooms sr ON r.room_id = sr.id
      LEFT JOIN server_rooms sr_direct ON a.room_id = sr_direct.id
      LEFT JOIN vendor_info v ON a.vendor_id = v.id
      WHERE 1=1
    `;
    const params = [];
    let idx = 1;

    if (filters.asset_type) {
      sql += ` AND a.asset_type = $${idx++}`;
      params.push(filters.asset_type);
    }
    if (filters.ownership) {
      sql += ` AND a.ownership = $${idx++}`;
      params.push(filters.ownership);
    }
    if (filters.status) {
      sql += ` AND a.status = $${idx++}`;
      params.push(filters.status);
    }
    if (filters.rack_id) {
      sql += ` AND a.rack_id = $${idx++}`;
      params.push(filters.rack_id);
    }
    if (filters.room_id) {
      sql += ` AND (a.room_id = $${idx} OR r.room_id = $${idx})`;
      params.push(filters.room_id);
      idx++;
    }
    if (filters.vendor_id) {
      sql += ` AND a.vendor_id = $${idx++}`;
      params.push(filters.vendor_id);
    }
    if (filters.search) {
      const s = '%' + filters.search + '%';
      sql += ` AND (a.asset_number ILIKE $${idx} OR a.management_number ILIKE $${idx+1} OR a.model_name ILIKE $${idx+2} OR a.serial_number ILIKE $${idx+3} OR a.assigned_user ILIKE $${idx+4})`;
      params.push(s, s, s, s, s);
      idx += 5;
    }

    sql += ' ORDER BY a.created_at DESC';
    const { rows } = await pool.query(sql, params);
    return rows;
  },

  async findByRack(rackId, { includeInactive = false } = {}) {
    const statusFilter = includeInactive
      ? "AND status NOT IN ('returned')"
      : "AND status NOT IN ('inactive','returned')";
    const { rows } = await pool.query(
      `SELECT * FROM assets WHERE rack_id = $1 ${statusFilter} ORDER BY rack_unit_start`,
      [rackId]
    );
    return rows;
  },

  async totalCount() {
    const { rows } = await pool.query("SELECT COUNT(*) as count FROM assets WHERE status != 'decommissioned'");
    return parseInt(rows[0].count);
  },

  async countByType() {
    const { rows } = await pool.query(
      "SELECT asset_type, COUNT(*) as count FROM assets WHERE status != 'decommissioned' GROUP BY asset_type"
    );
    return rows;
  },

  async countByOwnership() {
    const { rows } = await pool.query(
      "SELECT ownership, COUNT(*) as count FROM assets WHERE status != 'decommissioned' GROUP BY ownership"
    );
    return rows;
  },

  async countByStatus() {
    const { rows } = await pool.query(
      'SELECT status, COUNT(*) as count FROM assets GROUP BY status'
    );
    return rows;
  },

  async countByRoom() {
    const { rows } = await pool.query(
      `SELECT sr.name as room_name, COUNT(a.id) as count
       FROM assets a JOIN server_rooms sr ON a.room_id = sr.id
       WHERE a.status NOT IN ('inactive','decommissioned')
       GROUP BY sr.name ORDER BY count DESC`
    );
    return rows;
  }
};

module.exports = Asset;
