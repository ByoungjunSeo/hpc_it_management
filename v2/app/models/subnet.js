const { pool } = require('../config/database');
const { fixRowDates } = require('../utils/dateFix');

function fixDates(row) {
  return fixRowDates(row, [], ['created_at']);
}

const Subnet = {
  // 서브넷 목록 + ip_addresses 풀 집계 (cidr 문자열 느슨한 결합)
  async findAllWithStats() {
    const { rows } = await pool.query(`
      SELECT s.*,
             COUNT(ip.id) AS total,
             SUM(CASE WHEN ip.allocation_type = 'available' THEN 1 ELSE 0 END) AS available,
             SUM(CASE WHEN ip.allocation_type = 'assigned'  THEN 1 ELSE 0 END) AS assigned,
             SUM(CASE WHEN ip.allocation_type = 'reserved'  THEN 1 ELSE 0 END) AS reserved
      FROM subnets s
      LEFT JOIN ip_addresses ip ON ip.subnet = s.cidr
      GROUP BY s.id
      ORDER BY s.network_zone, s.cidr
    `);
    return rows.map(fixDates);
  },

  async findById(id) {
    const { rows } = await pool.query('SELECT * FROM subnets WHERE id = $1', [id]);
    return fixDates(rows[0] || null);
  },

  async findByCidr(cidr) {
    const { rows } = await pool.query('SELECT * FROM subnets WHERE cidr = $1', [cidr]);
    return rows[0] || null;
  },

  async create({ name, cidr, network_zone, description, created_by }) {
    const { rows } = await pool.query(
      `INSERT INTO subnets (name, cidr, network_zone, description, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [name, cidr, network_zone, description || null, created_by || null]
    );
    return rows[0].id;
  },

  async delete(id) {
    return pool.query('DELETE FROM subnets WHERE id = $1', [id]);
  }
};

module.exports = Subnet;
