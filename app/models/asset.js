const { getDb } = require('../config/database');

const Asset = {
  findAll(filters = {}) {
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

    if (filters.asset_type) {
      sql += ' AND a.asset_type = ?';
      params.push(filters.asset_type);
    }
    if (filters.ownership) {
      sql += ' AND a.ownership = ?';
      params.push(filters.ownership);
    }
    if (filters.status) {
      sql += ' AND a.status = ?';
      params.push(filters.status);
    }
    if (filters.rack_id) {
      sql += ' AND a.rack_id = ?';
      params.push(filters.rack_id);
    }
    if (filters.room_id) {
      sql += ' AND (a.room_id = ? OR r.room_id = ?)';
      params.push(filters.room_id, filters.room_id);
    }
    if (filters.vendor_id) {
      sql += ' AND a.vendor_id = ?';
      params.push(filters.vendor_id);
    }
    if (filters.search) {
      sql += ' AND (a.asset_number LIKE ? OR a.management_number LIKE ? OR a.model_name LIKE ? OR a.serial_number LIKE ? OR a.assigned_user LIKE ?)';
      const s = '%' + filters.search + '%';
      params.push(s, s, s, s, s);
    }

    sql += ' ORDER BY a.created_at DESC';
    return getDb().prepare(sql).all(...params);
  },

  findById(id) {
    return getDb().prepare(`
      SELECT a.*, r.name as rack_name,
        COALESCE(sr_direct.name, sr.name) as room_name,
        COALESCE(a.room_id, sr.id) as room_id,
        v.vendor_name
      FROM assets a
      LEFT JOIN racks r ON a.rack_id = r.id
      LEFT JOIN server_rooms sr ON r.room_id = sr.id
      LEFT JOIN server_rooms sr_direct ON a.room_id = sr_direct.id
      LEFT JOIN vendor_info v ON a.vendor_id = v.id
      WHERE a.id = ?
    `).get(id);
  },

  findByRack(rackId, { includeInactive = false } = {}) {
    if (includeInactive) {
      return getDb().prepare(`
        SELECT * FROM assets WHERE rack_id = ? AND status NOT IN ('returned') ORDER BY rack_unit_start
      `).all(rackId);
    }
    return getDb().prepare(`
      SELECT * FROM assets WHERE rack_id = ? AND status NOT IN ('inactive','returned') ORDER BY rack_unit_start
    `).all(rackId);
  },

  findByIp(ip) {
    return getDb().prepare('SELECT * FROM assets WHERE ip_address = ?').get(ip);
  },

  checkDuplicateAssetNumber(assetNumber, excludeId) {
    if (!assetNumber || !assetNumber.trim()) return null;
    const sql = excludeId
      ? 'SELECT id, asset_number FROM assets WHERE asset_number = ? AND id != ?'
      : 'SELECT id, asset_number FROM assets WHERE asset_number = ?';
    const params = excludeId ? [assetNumber.trim(), excludeId] : [assetNumber.trim()];
    return getDb().prepare(sql).get(...params);
  },

  checkRackUnitOverlap(rackId, unitStart, unitSize, bladeSlot, excludeId) {
    if (!rackId || !unitStart) return null;
    const size = parseInt(unitSize) || 3;
    const newStart = parseInt(unitStart);
    const newEnd = newStart + size - 1;

    // 다중노드: 자기 자신 + 부모 섀시 + 형제 노드 모두 제외
    const excludeIds = [];
    if (excludeId) {
      excludeIds.push(parseInt(excludeId));
      const self = getDb().prepare('SELECT parent_asset_id FROM assets WHERE id = ?').get(excludeId);
      if (self && self.parent_asset_id) {
        excludeIds.push(self.parent_asset_id);
        const siblings = getDb().prepare('SELECT id FROM assets WHERE parent_asset_id = ?').all(self.parent_asset_id);
        for (const s of siblings) excludeIds.push(s.id);
      } else {
        const children = getDb().prepare('SELECT id FROM assets WHERE parent_asset_id = ?').all(excludeId);
        for (const c of children) excludeIds.push(c.id);
      }
    }

    const placeholders = excludeIds.length > 0 ? ' AND id NOT IN (' + excludeIds.map(() => '?').join(',') + ')' : '';
    const others = getDb().prepare(
      'SELECT id, asset_number, rack_unit_start, rack_unit_size, blade_slot FROM assets WHERE rack_id = ? AND rack_unit_start IS NOT NULL AND status NOT IN (\'inactive\',\'returned\')' + placeholders
    ).all(rackId, ...excludeIds);
    for (const a of others) {
      const aStart = a.rack_unit_start;
      const aEnd = aStart + (a.rack_unit_size || 3) - 1;
      if (newStart <= aEnd && newEnd >= aStart) {
        if (bladeSlot && a.blade_slot && bladeSlot !== a.blade_slot) continue;
        if (!bladeSlot || !a.blade_slot) {
          const uPos = Math.floor((a.rack_unit_start - 1) / 3) + 1;
          return { asset: a, message: 'U' + uPos + ' ' + (a.asset_number || 'ID:' + a.id) + '와(과) 위치가 겹칩니다.' };
        }
      }
    }
    return null;
  },

  create(data) {
    const stmt = getDb().prepare(`
      INSERT INTO assets (asset_number, management_number, asset_type, ownership, vendor_id,
        model_name, manufacturer, serial_number, room_id, rack_id, rack_unit_start, rack_unit_size,
        parent_asset_id, blade_slot,
        ip_address, ssh_port, ssh_user, ssh_password, assigned_user, purpose, status,
        purchase_date, warranty_end, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      data.asset_number, data.management_number, data.asset_type, data.ownership || 'company',
      data.vendor_id || null, data.model_name, data.manufacturer, data.serial_number,
      data.room_id || null, data.rack_id || null, data.rack_unit_start || null, parseInt(data.rack_unit_size) || 3,
      data.parent_asset_id || null, data.blade_slot || null,
      data.ip_address, data.ssh_port || 22, data.ssh_user || 'root', data.ssh_password,
      data.assigned_user, data.purpose, data.status || 'active',
      data.purchase_date || null, data.warranty_end || null, data.notes
    );
    return result.lastInsertRowid;
  },

  update(id, data) {
    const stmt = getDb().prepare(`
      UPDATE assets SET asset_number=?, management_number=?, asset_type=?, ownership=?, vendor_id=?,
        model_name=?, manufacturer=?, serial_number=?, room_id=?, rack_id=?, rack_unit_start=?, rack_unit_size=?,
        parent_asset_id=?, blade_slot=?,
        ip_address=?, ssh_port=?, ssh_user=?, ssh_password=?, assigned_user=?, purpose=?, status=?,
        purchase_date=?, warranty_end=?, notes=?, updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `);
    return stmt.run(
      data.asset_number, data.management_number, data.asset_type, data.ownership || 'company',
      data.vendor_id || null, data.model_name, data.manufacturer, data.serial_number,
      data.room_id || null, data.rack_id || null, data.rack_unit_start || null, parseInt(data.rack_unit_size) || 3,
      data.parent_asset_id || null, data.blade_slot || null,
      data.ip_address, data.ssh_port || 22, data.ssh_user || 'root', data.ssh_password,
      data.assigned_user, data.purpose, data.status || 'active',
      data.purchase_date || null, data.warranty_end || null, data.notes, id
    );
  },

  updateUnitPosition(id, rackUnitStart) {
    return getDb().prepare(
      'UPDATE assets SET rack_unit_start=?, updated_at=CURRENT_TIMESTAMP WHERE id=?'
    ).run(rackUnitStart, id);
  },

  delete(id) {
    return getDb().prepare('DELETE FROM assets WHERE id = ?').run(id);
  },

  findByManagementNumber(managementNumber) {
    return getDb().prepare(`
      SELECT * FROM assets WHERE management_number = ?
    `).get(managementNumber);
  },

  markReturned(id) {
    return getDb().prepare(`
      UPDATE assets SET status='returned', room_id=NULL, rack_id=NULL, rack_unit_start=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?
    `).run(id);
  },

  reactivate(id) {
    return getDb().prepare(`
      UPDATE assets SET status='active', updated_at=CURRENT_TIMESTAMP WHERE id=?
    `).run(id);
  },

  countByType() {
    return getDb().prepare(`
      SELECT asset_type, COUNT(*) as count FROM assets WHERE status != 'decommissioned' GROUP BY asset_type
    `).all();
  },

  countByOwnership() {
    return getDb().prepare(`
      SELECT ownership, COUNT(*) as count FROM assets WHERE status != 'decommissioned' GROUP BY ownership
    `).all();
  },

  totalCount() {
    return getDb().prepare("SELECT COUNT(*) as count FROM assets WHERE status != 'decommissioned'").get().count;
  },

  findByIpWithCredentials(ip) {
    const db = getDb();
    // Search in asset_ips table
    const assetIps = db.prepare(`
      SELECT ai.*, a.id as asset_id, a.asset_number, a.model_name, a.manufacturer, a.asset_type
      FROM asset_ips ai
      JOIN assets a ON ai.asset_id = a.id
      WHERE ai.ip_address = ?
    `).all(ip);
    // Also check the legacy ip_address field on assets
    const legacyAsset = db.prepare(`
      SELECT id as asset_id, asset_number, model_name, manufacturer, asset_type
      FROM assets WHERE ip_address = ?
    `).get(ip);

    const assetIds = new Set();
    const results = [];

    assetIps.forEach(ai => {
      if (!assetIds.has(ai.asset_id)) {
        assetIds.add(ai.asset_id);
        const credentials = db.prepare('SELECT * FROM asset_credentials WHERE asset_id = ?').all(ai.asset_id);
        results.push({
          asset_id: ai.asset_id,
          asset_number: ai.asset_number,
          model_name: ai.model_name,
          manufacturer: ai.manufacturer,
          asset_type: ai.asset_type,
          ip_type: ai.ip_type,
          credentials
        });
      }
    });

    if (legacyAsset && !assetIds.has(legacyAsset.asset_id)) {
      const credentials = db.prepare('SELECT * FROM asset_credentials WHERE asset_id = ?').all(legacyAsset.asset_id);
      // Also include legacy ssh creds from asset table
      const fullAsset = db.prepare('SELECT ssh_user, ssh_password, ssh_port FROM assets WHERE id = ?').get(legacyAsset.asset_id);
      if (fullAsset && fullAsset.ssh_user && credentials.length === 0) {
        credentials.push({ username: fullAsset.ssh_user, password: fullAsset.ssh_password, credential_type: 'root', description: 'Legacy SSH' });
      }
      results.push({
        asset_id: legacyAsset.asset_id,
        asset_number: legacyAsset.asset_number,
        model_name: legacyAsset.model_name,
        manufacturer: legacyAsset.manufacturer,
        asset_type: legacyAsset.asset_type,
        ip_type: 'management',
        credentials
      });
    }

    return results;
  },

  findChildren(parentId) {
    return getDb().prepare(`
      SELECT a.*, r.name as rack_name,
        COALESCE(sr_direct.name, sr.name) as room_name,
        v.vendor_name
      FROM assets a
      LEFT JOIN racks r ON a.rack_id = r.id
      LEFT JOIN server_rooms sr ON r.room_id = sr.id
      LEFT JOIN server_rooms sr_direct ON a.room_id = sr_direct.id
      LEFT JOIN vendor_info v ON a.vendor_id = v.id
      WHERE a.parent_asset_id = ?
      ORDER BY a.management_number
    `).all(parentId);
  },

  countByStatus() {
    return getDb().prepare(
      `SELECT status, COUNT(*) as count FROM assets GROUP BY status`
    ).all();
  },

  countByRoom() {
    return getDb().prepare(
      `SELECT sr.name as room_name, COUNT(a.id) as count
       FROM assets a JOIN server_rooms sr ON a.room_id = sr.id
       WHERE a.status NOT IN ('inactive','decommissioned')
       GROUP BY sr.name ORDER BY count DESC`
    ).all();
  },

  getVendorAssets() {
    return getDb().prepare(`
      SELECT a.*, r.name as rack_name,
        COALESCE(sr_direct.name, sr.name) as room_name,
        v.vendor_name, v.contact_person, v.contract_end,
        GROUP_CONCAT(DISTINCT ai.ip_address) as all_ips
      FROM assets a
      LEFT JOIN racks r ON a.rack_id = r.id
      LEFT JOIN server_rooms sr ON r.room_id = sr.id
      LEFT JOIN server_rooms sr_direct ON a.room_id = sr_direct.id
      LEFT JOIN vendor_info v ON a.vendor_id = v.id
      LEFT JOIN asset_ips ai ON ai.asset_id = a.id
      WHERE a.ownership = 'vendor'
      GROUP BY a.id
      ORDER BY v.vendor_name, a.management_number
    `).all();
  }
};

module.exports = Asset;
