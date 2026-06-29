const { pool } = require('../config/database');
const appConfig = require('../config/app');

const IpAddress = {
  async initializeSubnets() {
    const { rows } = await pool.query('SELECT COUNT(*) as count FROM ip_addresses');
    if (parseInt(rows[0].count) > 0) return;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const s of appConfig.subnets) {
        const base = s.subnet.split('/')[0];
        const parts = base.split('.');
        for (let i = 0; i < 256; i++) {
          const ip = parts[0] + '.' + parts[1] + '.' + parts[2] + '.' + i;
          await client.query(
            `INSERT INTO ip_addresses (ip_address, subnet, network_zone, allocation_type)
             VALUES ($1, $2, $3, 'available') ON CONFLICT DO NOTHING`,
            [ip, s.subnet, s.zone]
          );
        }
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  async getTotalStats() {
    const { rows } = await pool.query(
      `SELECT
        COUNT(*) as total,
        SUM(CASE WHEN allocation_type = 'available' THEN 1 ELSE 0 END) as available,
        SUM(CASE WHEN allocation_type = 'assigned' THEN 1 ELSE 0 END) as assigned,
        SUM(CASE WHEN allocation_type = 'reserved' THEN 1 ELSE 0 END) as reserved
       FROM ip_addresses`
    );
    return rows[0];
  }
};

module.exports = IpAddress;
