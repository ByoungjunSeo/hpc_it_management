const { pool } = require('../config/database');
const appConfig = require('../config/app');
const { fixRowDates } = require('../utils/dateFix');

// B-4d-9 Date 직렬화 스윕
function fixDates(row) {
  return fixRowDates(row, [], ['created_at', 'updated_at']);
}

// ── B-6e: CIDR 유틸 (/16~/30) ──
function ipToInt(ip) {
  const p = ip.split('.').map(Number);
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}
function intToIp(n) {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}
// cidr('10.0.0.0/22') → { firstInt, lastInt, size, prefix }
function cidrRange(cidr) {
  const [base, prefixStr] = cidr.split('/');
  const prefix = parseInt(prefixStr, 10);
  const size = Math.pow(2, 32 - prefix);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const firstInt = (ipToInt(base) & mask) >>> 0;
  return { firstInt, lastInt: firstInt + size - 1, size, prefix };
}
// 두 CIDR 범위가 겹치는지
function cidrsOverlap(a, b) {
  const ra = cidrRange(a);
  const rb = cidrRange(b);
  return ra.firstInt <= rb.lastInt && rb.firstInt <= ra.lastInt;
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

  // CIDR 대역 전체(네트워크~브로드캐스트 포함) 풀 생성. multi-row 배치 INSERT.
  // /16~/30 지원. 기존 /24 동작(256행 전주소 시딩)과 정합 — 제외 없이 전 범위.
  async _insertPool(client, cidr, zone) {
    const { firstInt, size } = cidrRange(cidr);
    const BATCH = 1000;
    let batch = [];
    const flush = async () => {
      if (batch.length === 0) return;
      // (ip, subnet, zone) 3열 묶음 → VALUES ($1,$2,$3),($4,$5,$6)...
      const values = [];
      const params = [];
      batch.forEach((ip, i) => {
        values.push(`($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3}, 'available')`);
        params.push(ip, cidr, zone);
      });
      await client.query(
        `INSERT INTO ip_addresses (ip_address, subnet, network_zone, allocation_type)
         VALUES ${values.join(',')} ON CONFLICT DO NOTHING`,
        params
      );
      batch = [];
    };
    for (let i = 0; i < size; i++) {
      batch.push(intToIp(firstInt + i));
      if (batch.length >= BATCH) await flush();
    }
    await flush();
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

  // B-6e: blockBase('10.100.60') 지정 시 해당 /24 블록만 (대량 대역 페이지네이션)
  async findBySubnet(subnet, blockBase) {
    let sql = `SELECT ip.*, a.model_name as asset_model, a.asset_number, a.ownership as asset_ownership,
              a.management_number as asset_mgmt_number,
              a.assigned_user as asset_user, a.purpose as asset_purpose
       FROM ip_addresses ip
       LEFT JOIN assets a ON ip.asset_id = a.id
       WHERE ip.subnet = $1`;
    const params = [subnet];
    if (blockBase) {
      sql += ` AND ip.ip_address LIKE $2`;
      params.push(blockBase + '.%');
    }
    const { rows } = await pool.query(sql, params);
    // Sort by last octet numerically (블록 필터 시 같은 앞3옥텟이라 안전)
    rows.sort((a, b) => {
      const lastA = parseInt(a.ip_address.split('.').pop());
      const lastB = parseInt(b.ip_address.split('.').pop());
      return lastA - lastB;
    });
    return rows.map(fixDates);
  },

  // B-6e: 대역의 /24 블록 앞3옥텟 목록 (페이지네이션 네비용). /24 이하면 [단일].
  blocksOf(cidr) {
    const r = cidrRange(cidr);
    const count = Math.ceil(r.size / 256);
    const blocks = [];
    for (let b = 0; b < count; b++) {
      blocks.push(intToIp(r.firstInt + b * 256).split('.').slice(0, 3).join('.'));
    }
    return blocks;
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

// B-6e: 라우트에서 CIDR 검증·겹침 검사에 재사용
IpAddress.cidrRange = cidrRange;
IpAddress.cidrsOverlap = cidrsOverlap;
IpAddress.ipToInt = ipToInt;

module.exports = IpAddress;
