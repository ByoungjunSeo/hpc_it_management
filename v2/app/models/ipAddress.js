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
  },

  async findBySubnet(subnet) {
    const { rows } = await pool.query(
      `SELECT ip.*, a.model_name as asset_model, a.asset_number, a.ownership as asset_ownership,
              a.management_number as asset_mgmt_number,
              a.assigned_user as asset_user, a.purpose as asset_purpose
       FROM ip_addresses ip
       LEFT JOIN assets a ON ip.asset_id = a.id
       WHERE ip.subnet = $1`,
      [subnet]
    );
    // Sort by last octet numerically
    rows.sort((a, b) => {
      const lastA = parseInt(a.ip_address.split('.').pop());
      const lastB = parseInt(b.ip_address.split('.').pop());
      return lastA - lastB;
    });
    return rows;
  },

  async getSubnetStats() {
    const { rows } = await pool.query(
      `SELECT subnet, network_zone,
              COUNT(*) as total,
              SUM(CASE WHEN allocation_type = 'available' THEN 1 ELSE 0 END) as available,
              SUM(CASE WHEN allocation_type = 'assigned' THEN 1 ELSE 0 END) as assigned,
              SUM(CASE WHEN allocation_type = 'reserved' THEN 1 ELSE 0 END) as reserved
       FROM ip_addresses
       GROUP BY subnet, network_zone
       ORDER BY subnet`
    );
    return rows;
  },

  async release(ip) {
    return pool.query(
      `UPDATE ip_addresses SET allocation_type='available', asset_id=NULL, assigned_to=NULL,
              description=NULL, updated_at=NOW()
       WHERE ip_address=$1`,
      [ip]
    );
  },

  async syncAssetIps(assetId, ipList) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Release all IPs currently assigned to this asset
      await client.query(
        `UPDATE ip_addresses SET allocation_type='available', asset_id=NULL, assigned_to=NULL, updated_at=NOW()
         WHERE asset_id=$1`, [assetId]
      );
      // Assign new list
      for (const ip of ipList) {
        if (ip && ip.trim()) {
          await client.query(
            `UPDATE ip_addresses SET allocation_type='assigned', asset_id=$1, updated_at=NOW()
             WHERE ip_address=$2`, [assetId, ip.trim()]
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

  async updateAllocation(ip, data) {
    return pool.query(
      `UPDATE ip_addresses SET allocation_type=$1, asset_id=$2, assigned_to=$3,
              description=$4, updated_at=NOW()
       WHERE ip_address=$5`,
      [data.allocation_type, data.asset_id || null, data.assigned_to || null, data.description || null, ip]
    );
  }
};

module.exports = IpAddress;
