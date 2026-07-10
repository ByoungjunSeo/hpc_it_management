const { pool } = require('../config/database');
const appConfig = require('../config/app');
const { fixRowDates } = require('../utils/dateFix');

// B-4d-9 Date 직렬화 스윕
function fixDates(row) {
  return fixRowDates(row, [], ['created_at', 'updated_at']);
}

const IpAddress = {
  // B-6e: 최초 기동 시 SUBNETS_JSON(appConfig.subnets)을 subnets 테이블 + ip_addresses 풀에
  // 동시 시딩. subnets 테이블이 비었을 때만 동작(멱등). 이후 서브넷 관리는 UI(subnets CRUD).
  async initializeSubnets() {
    const { rows } = await pool.query('SELECT COUNT(*) as count FROM subnets');
    if (parseInt(rows[0].count) > 0) return;
    if (!appConfig.subnets || appConfig.subnets.length === 0) return;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const s of appConfig.subnets) {
        await client.query(
          `INSERT INTO subnets (name, cidr, network_zone, created_by)
           VALUES ($1, $2, $3, 'seed') ON CONFLICT (cidr) DO NOTHING`,
          [s.label || s.subnet, s.subnet, s.zone]
        );
        await this._insertPool(client, s.subnet, s.zone);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  // /24 대역 256행(0~255) 생성. client 없으면 자체 연결.
  async _insertPool(client, cidr, zone) {
    const base = cidr.split('/')[0];
    const parts = base.split('.');
    for (let i = 0; i < 256; i++) {
      const ip = parts[0] + '.' + parts[1] + '.' + parts[2] + '.' + i;
      await client.query(
        `INSERT INTO ip_addresses (ip_address, subnet, network_zone, allocation_type)
         VALUES ($1, $2, $3, 'available') ON CONFLICT DO NOTHING`,
        [ip, cidr, zone]
      );
    }
  },

  // B-6e: 서브넷 등록 시 풀 생성 (단일 대역)
  async createPool(cidr, zone) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await this._insertPool(client, cidr, zone);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  // B-6e: 서브넷 삭제 시 풀 제거 (대역 전체 행)
  async deletePool(cidr) {
    return pool.query('DELETE FROM ip_addresses WHERE subnet = $1', [cidr]);
  },

  // B-6e: 대역별 할당 상태 카운트 (삭제 정책·고지용)
  async countByAllocation(cidr) {
    const { rows } = await pool.query(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN allocation_type = 'available' THEN 1 ELSE 0 END) AS available,
        SUM(CASE WHEN allocation_type = 'assigned'  THEN 1 ELSE 0 END) AS assigned,
        SUM(CASE WHEN allocation_type = 'reserved'  THEN 1 ELSE 0 END) AS reserved
      FROM ip_addresses WHERE subnet = $1
    `, [cidr]);
    const r = rows[0] || {};
    return {
      total: parseInt(r.total || 0),
      available: parseInt(r.available || 0),
      assigned: parseInt(r.assigned || 0),
      reserved: parseInt(r.reserved || 0)
    };
  },

  // B-6e: 주어진 IP 목록 중 어느 풀에도 없는 것(경고용)
  async findMissingFromPool(ipList) {
    const clean = (ipList || []).map(x => (x || '').trim()).filter(Boolean);
    if (clean.length === 0) return [];
    const { rows } = await pool.query(
      'SELECT ip_address FROM ip_addresses WHERE ip_address = ANY($1)', [clean]
    );
    const present = new Set(rows.map(r => r.ip_address));
    return clean.filter(ip => !present.has(ip));
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
    return rows.map(fixDates);
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
