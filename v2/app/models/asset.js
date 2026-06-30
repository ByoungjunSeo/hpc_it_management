const { pool } = require('../config/database');
const { fixRowDates } = require('../utils/dateFix');

function fixDates(row) {
  return fixRowDates(row, ['purchase_date', 'warranty_end'],
    ['purchase_date', 'warranty_end', 'created_at', 'updated_at']);
}

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
  },

  async findById(id) {
    const { rows } = await pool.query(`
      SELECT a.*, r.name as rack_name,
        COALESCE(sr_direct.name, sr.name) as room_name,
        COALESCE(a.room_id, sr.id) as room_id,
        v.vendor_name
      FROM assets a
      LEFT JOIN racks r ON a.rack_id = r.id
      LEFT JOIN server_rooms sr ON r.room_id = sr.id
      LEFT JOIN server_rooms sr_direct ON a.room_id = sr_direct.id
      LEFT JOIN vendor_info v ON a.vendor_id = v.id
      WHERE a.id = $1
    `, [id]);
    return fixDates(rows[0]) || null;
  },

  async findByIp(ip) {
    const { rows } = await pool.query('SELECT * FROM assets WHERE ip_address = $1', [ip]);
    return fixDates(rows[0]) || null;
  },

  async findByManagementNumber(managementNumber) {
    const { rows } = await pool.query('SELECT * FROM assets WHERE management_number = $1', [managementNumber]);
    return fixDates(rows[0]) || null;
  },

  async findChildren(parentId) {
    const { rows } = await pool.query(`
      SELECT a.*, r.name as rack_name,
        COALESCE(sr_direct.name, sr.name) as room_name,
        v.vendor_name
      FROM assets a
      LEFT JOIN racks r ON a.rack_id = r.id
      LEFT JOIN server_rooms sr ON r.room_id = sr.id
      LEFT JOIN server_rooms sr_direct ON a.room_id = sr_direct.id
      LEFT JOIN vendor_info v ON a.vendor_id = v.id
      WHERE a.parent_asset_id = $1
      ORDER BY a.management_number
    `, [parentId]);
    rows.forEach(fixDates);
    return rows;
  },

  async checkDuplicateAssetNumber(assetNumber, excludeId) {
    if (!assetNumber || !assetNumber.trim()) return null;
    const trimmed = assetNumber.trim();
    if (excludeId) {
      const { rows } = await pool.query(
        'SELECT id, asset_number FROM assets WHERE asset_number = $1 AND id != $2',
        [trimmed, excludeId]
      );
      return rows[0] || null;
    }
    const { rows } = await pool.query(
      'SELECT id, asset_number FROM assets WHERE asset_number = $1',
      [trimmed]
    );
    return rows[0] || null;
  },

  async checkRackUnitOverlap(rackId, unitStart, unitSize, bladeSlot, excludeId) {
    if (!rackId || !unitStart) return null;
    const size = parseInt(unitSize) || 3;
    const newStart = parseInt(unitStart);
    const newEnd = newStart + size - 1;

    // 다중노드: 자기 자신 + 부모 섀시 + 형제 노드 모두 제외
    const excludeIds = [];
    if (excludeId) {
      excludeIds.push(parseInt(excludeId));
      const { rows: selfRows } = await pool.query('SELECT parent_asset_id FROM assets WHERE id = $1', [excludeId]);
      const self = selfRows[0];
      if (self && self.parent_asset_id) {
        excludeIds.push(self.parent_asset_id);
        const { rows: siblings } = await pool.query('SELECT id FROM assets WHERE parent_asset_id = $1', [self.parent_asset_id]);
        for (const s of siblings) excludeIds.push(s.id);
      } else {
        const { rows: children } = await pool.query('SELECT id FROM assets WHERE parent_asset_id = $1', [excludeId]);
        for (const c of children) excludeIds.push(c.id);
      }
    }

    let sql = `SELECT id, asset_number, rack_unit_start, rack_unit_size, blade_slot
               FROM assets WHERE rack_id = $1 AND rack_unit_start IS NOT NULL
               AND status NOT IN ('inactive','returned')`;
    const params = [rackId];
    if (excludeIds.length > 0) {
      const placeholders = excludeIds.map((_, i) => '$' + (i + 2)).join(',');
      sql += ' AND id NOT IN (' + placeholders + ')';
      params.push(...excludeIds);
    }

    const { rows: others } = await pool.query(sql, params);
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

  async create(data) {
    const { rows } = await pool.query(`
      INSERT INTO assets (asset_number, management_number, asset_type, ownership, vendor_id,
        model_name, manufacturer, serial_number, room_id, rack_id, rack_unit_start, rack_unit_size,
        parent_asset_id, blade_slot,
        ip_address, ssh_port, ssh_user, ssh_password, assigned_user, purpose, status,
        purchase_date, warranty_end, notes)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
              $15, $16, $17, $18, $19, $20, $21, $22, $23, $24)
      RETURNING id`,
      [data.asset_number, data.management_number, data.asset_type, data.ownership || 'company',
       data.vendor_id || null, data.model_name, data.manufacturer, data.serial_number,
       data.room_id || null, data.rack_id || null, data.rack_unit_start || null, parseInt(data.rack_unit_size) || 3,
       data.parent_asset_id || null, data.blade_slot || null,
       data.ip_address, data.ssh_port || 22, data.ssh_user || 'root', data.ssh_password,
       data.assigned_user, data.purpose, data.status || 'active',
       data.purchase_date || null, data.warranty_end || null, data.notes]
    );
    return rows[0].id;
  },

  async update(id, data) {
    return pool.query(`
      UPDATE assets SET asset_number=$1, management_number=$2, asset_type=$3, ownership=$4, vendor_id=$5,
        model_name=$6, manufacturer=$7, serial_number=$8, room_id=$9, rack_id=$10, rack_unit_start=$11, rack_unit_size=$12,
        parent_asset_id=$13, blade_slot=$14,
        ip_address=$15, ssh_port=$16, ssh_user=$17, ssh_password=$18, assigned_user=$19, purpose=$20, status=$21,
        purchase_date=$22, warranty_end=$23, notes=$24, updated_at=CURRENT_TIMESTAMP
      WHERE id=$25`,
      [data.asset_number, data.management_number, data.asset_type, data.ownership || 'company',
       data.vendor_id || null, data.model_name, data.manufacturer, data.serial_number,
       data.room_id || null, data.rack_id || null, data.rack_unit_start || null, parseInt(data.rack_unit_size) || 3,
       data.parent_asset_id || null, data.blade_slot || null,
       data.ip_address, data.ssh_port || 22, data.ssh_user || 'root', data.ssh_password,
       data.assigned_user, data.purpose, data.status || 'active',
       data.purchase_date || null, data.warranty_end || null, data.notes, id]
    );
  },

  async updateUnitPosition(id, rackUnitStart) {
    return pool.query(
      'UPDATE assets SET rack_unit_start=$1, updated_at=CURRENT_TIMESTAMP WHERE id=$2',
      [rackUnitStart, id]
    );
  },

  async delete(id) {
    return pool.query('DELETE FROM assets WHERE id = $1', [id]);
  },

  async markReturned(id) {
    return pool.query(
      `UPDATE assets SET status='returned', room_id=NULL, rack_id=NULL, rack_unit_start=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=$1`,
      [id]
    );
  },

  async reactivate(id) {
    return pool.query(
      `UPDATE assets SET status='active', updated_at=CURRENT_TIMESTAMP WHERE id=$1`,
      [id]
    );
  },

  async findByIpWithCredentials(ip) {
    // Search in asset_ips table
    const { rows: assetIps } = await pool.query(`
      SELECT ai.*, a.id as asset_id, a.asset_number, a.model_name, a.manufacturer, a.asset_type
      FROM asset_ips ai
      JOIN assets a ON ai.asset_id = a.id
      WHERE ai.ip_address = $1
    `, [ip]);
    // Also check the legacy ip_address field on assets
    const { rows: legacyRows } = await pool.query(`
      SELECT id as asset_id, asset_number, model_name, manufacturer, asset_type
      FROM assets WHERE ip_address = $1
    `, [ip]);
    const legacyAsset = legacyRows[0] || null;

    const assetIds = new Set();
    const results = [];

    for (const ai of assetIps) {
      if (!assetIds.has(ai.asset_id)) {
        assetIds.add(ai.asset_id);
        const { rows: credentials } = await pool.query('SELECT * FROM asset_credentials WHERE asset_id = $1', [ai.asset_id]);
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
    }

    if (legacyAsset && !assetIds.has(legacyAsset.asset_id)) {
      const { rows: credentials } = await pool.query('SELECT * FROM asset_credentials WHERE asset_id = $1', [legacyAsset.asset_id]);
      // Also include legacy ssh creds from asset table
      const { rows: fullRows } = await pool.query('SELECT ssh_user, ssh_password, ssh_port FROM assets WHERE id = $1', [legacyAsset.asset_id]);
      const fullAsset = fullRows[0];
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

  async getVendorAssets() {
    const { rows } = await pool.query(`
      SELECT a.*, r.name as rack_name,
        COALESCE(sr_direct.name, sr.name) as room_name,
        v.vendor_name, v.contact_person, v.contract_end,
        STRING_AGG(DISTINCT ai.ip_address, ',') as all_ips
      FROM assets a
      LEFT JOIN racks r ON a.rack_id = r.id
      LEFT JOIN server_rooms sr ON r.room_id = sr.id
      LEFT JOIN server_rooms sr_direct ON a.room_id = sr_direct.id
      LEFT JOIN vendor_info v ON a.vendor_id = v.id
      LEFT JOIN asset_ips ai ON ai.asset_id = a.id
      WHERE a.ownership = 'vendor'
      GROUP BY a.id, r.name, sr_direct.name, sr.name, sr.id, v.vendor_name, v.contact_person, v.contract_end
      ORDER BY v.vendor_name, a.management_number
    `);
    rows.forEach(fixDates);
    return rows;
  }
};

module.exports = Asset;
