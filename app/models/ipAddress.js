const { getDb } = require('../config/database');
const appConfig = require('../config/app');

const IpAddress = {
  // Initialize all IP addresses for configured subnets
  initializeSubnets() {
    const db = getDb();
    const existing = db.prepare('SELECT COUNT(*) as count FROM ip_addresses').get();
    if (existing.count > 0) return;

    const stmt = db.prepare(`
      INSERT OR IGNORE INTO ip_addresses (ip_address, subnet, network_zone, allocation_type)
      VALUES (?, ?, ?, 'available')
    `);

    const insertAll = db.transaction(() => {
      appConfig.subnets.forEach(s => {
        const base = s.subnet.split('/')[0];
        const parts = base.split('.');
        for (let i = 0; i < 256; i++) {
          const ip = parts[0] + '.' + parts[1] + '.' + parts[2] + '.' + i;
          stmt.run(ip, s.subnet, s.zone);
        }
      });
    });
    insertAll();
  },

  findBySubnet(subnet) {
    const rows = getDb().prepare(`
      SELECT ip.*, a.model_name as asset_model, a.asset_number, a.ownership as asset_ownership,
        a.management_number as asset_mgmt_number,
        a.assigned_user as asset_user, a.purpose as asset_purpose
      FROM ip_addresses ip
      LEFT JOIN assets a ON ip.asset_id = a.id
      WHERE ip.subnet = ?
    `).all(subnet);
    // Sort by last octet numerically (string ORDER BY gives wrong order: .1, .10, .100, .11...)
    rows.sort((a, b) => {
      const lastA = parseInt(a.ip_address.split('.').pop());
      const lastB = parseInt(b.ip_address.split('.').pop());
      return lastA - lastB;
    });
    return rows;
  },

  findByIp(ip) {
    return getDb().prepare(`
      SELECT ip.*, a.model_name as asset_model, a.asset_number
      FROM ip_addresses ip
      LEFT JOIN assets a ON ip.asset_id = a.id
      WHERE ip.ip_address = ?
    `).get(ip);
  },

  getSubnetStats() {
    return getDb().prepare(`
      SELECT subnet, network_zone,
        COUNT(*) as total,
        SUM(CASE WHEN allocation_type = 'available' THEN 1 ELSE 0 END) as available,
        SUM(CASE WHEN allocation_type = 'assigned' THEN 1 ELSE 0 END) as assigned,
        SUM(CASE WHEN allocation_type = 'reserved' THEN 1 ELSE 0 END) as reserved
      FROM ip_addresses
      GROUP BY subnet
      ORDER BY subnet
    `).all();
  },

  getTotalStats() {
    return getDb().prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN allocation_type = 'available' THEN 1 ELSE 0 END) as available,
        SUM(CASE WHEN allocation_type = 'assigned' THEN 1 ELSE 0 END) as assigned,
        SUM(CASE WHEN allocation_type = 'reserved' THEN 1 ELSE 0 END) as reserved
      FROM ip_addresses
    `).get();
  },

  assign(ip, data) {
    return getDb().prepare(`
      UPDATE ip_addresses SET allocation_type='assigned', asset_id=?, assigned_to=?,
        description=?, updated_at=CURRENT_TIMESTAMP
      WHERE ip_address=?
    `).run(data.asset_id || null, data.assigned_to, data.description, ip);
  },

  reserve(ip, data) {
    return getDb().prepare(`
      UPDATE ip_addresses SET allocation_type='reserved', assigned_to=?,
        description=?, updated_at=CURRENT_TIMESTAMP
      WHERE ip_address=?
    `).run(data.assigned_to, data.description, ip);
  },

  release(ip) {
    return getDb().prepare(`
      UPDATE ip_addresses SET allocation_type='available', asset_id=NULL, assigned_to=NULL,
        description=NULL, updated_at=CURRENT_TIMESTAMP
      WHERE ip_address=?
    `).run(ip);
  },

  updateAllocation(ip, data) {
    return getDb().prepare(`
      UPDATE ip_addresses SET allocation_type=?, asset_id=?, assigned_to=?,
        description=?, updated_at=CURRENT_TIMESTAMP
      WHERE ip_address=?
    `).run(data.allocation_type, data.asset_id || null, data.assigned_to, data.description, ip);
  },

  syncAssetIps(assetId, ipList) {
    const db = getDb();
    const syncTx = db.transaction(() => {
      // Release all IPs currently assigned to this asset
      db.prepare(`
        UPDATE ip_addresses SET allocation_type='available', asset_id=NULL, assigned_to=NULL,
          updated_at=CURRENT_TIMESTAMP
        WHERE asset_id=?
      `).run(assetId);
      // Assign new IPs
      const assignStmt = db.prepare(`
        UPDATE ip_addresses SET allocation_type='assigned', asset_id=?,
          updated_at=CURRENT_TIMESTAMP
        WHERE ip_address=?
      `);
      ipList.forEach(ip => {
        if (ip && ip.trim()) {
          assignStmt.run(assetId, ip.trim());
        }
      });
    });
    syncTx();
  },

  syncAllAssets() {
    const db = getDb();
    const assignStmt = db.prepare(`
      UPDATE ip_addresses SET allocation_type='assigned', asset_id=?,
        updated_at=CURRENT_TIMESTAMP
      WHERE ip_address=? AND (asset_id IS NULL OR asset_id != ?)
    `);

    const syncTx = db.transaction(() => {
      // 1) Sync from asset_ips table
      try {
        const assetIps = db.prepare(`
          SELECT ai.asset_id, ai.ip_address FROM asset_ips ai
          WHERE ai.ip_address IS NOT NULL AND ai.ip_address != ''
        `).all();
        assetIps.forEach(row => {
          assignStmt.run(row.asset_id, row.ip_address, row.asset_id);
        });
      } catch (e) { /* asset_ips table may not exist yet */ }

      // 2) Sync from equipment_usage_logs (latest record per asset)
      try {
        const usageLogs = db.prepare(`
          SELECT e.ip1, e.ip2, e.ip3, e.ip4, e.bmc, e.ib1, e.ib2, a.id as asset_id
          FROM equipment_usage_logs e
          JOIN assets a ON a.management_number = e.management_number
          WHERE e.id IN (
            SELECT MAX(e2.id) FROM equipment_usage_logs e2
            WHERE e2.management_number = e.management_number
          )
          AND (e.ip1 IS NOT NULL AND e.ip1 != '')
        `).all();

        // Also sync to asset_ips table (used by GPU monitoring, SSH discovery etc.)
        const checkAssetIp = db.prepare(
          'SELECT id FROM asset_ips WHERE asset_id = ? AND ip_address = ?'
        );
        const insertAssetIp = db.prepare(
          'INSERT INTO asset_ips (asset_id, ip_address, ip_type) VALUES (?, ?, ?)'
        );
        const ipTypeMap = { ip1: 'management', ip2: 'data', ip3: 'data', ip4: 'data', bmc: 'bmc', ib1: 'ib', ib2: 'ib' };

        usageLogs.forEach(row => {
          const fields = { ip1: row.ip1, ip2: row.ip2, ip3: row.ip3, ip4: row.ip4, bmc: row.bmc, ib1: row.ib1, ib2: row.ib2 };
          for (const [field, ip] of Object.entries(fields)) {
            if (ip && ip.trim()) {
              const trimmed = ip.trim();
              assignStmt.run(row.asset_id, trimmed, row.asset_id);
              // Insert into asset_ips if not exists
              if (!checkAssetIp.get(row.asset_id, trimmed)) {
                insertAssetIp.run(row.asset_id, trimmed, ipTypeMap[field] || 'management');
              }
            }
          }
        });
      } catch (e) { /* equipment_usage_logs table may not exist yet */ }
    });
    syncTx();
  }
};

module.exports = IpAddress;
