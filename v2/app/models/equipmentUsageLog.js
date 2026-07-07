const { pool } = require('../config/database');
const { fixRowDates } = require('../utils/dateFix');

// v2 event_type → Korean label mapping (dashboard.ejs expects Korean keys)
const EVENT_TYPE_LABEL = {
  incoming: '입고',
  in_use: '사용중',
  returned: '반납완료'
};

// Reverse: Korean status → event_type (write path)
const STATUS_TO_EVENT = {
  '입고': 'incoming',
  '사용중': 'in_use',
  '반납완료': 'returned'
};

// ─── JSONB Helper: flatten v2 snapshots → v1 individual columns ───
// Views expect 50+ individual columns (cpu_type, ip1, credential_root, etc.)
// This function adds those as virtual fields from JSONB snapshots.
function flattenSnapshot(row) {
  if (!row) return row;

  // -- Hardware: hardware_snapshot [{type,code,num}] → hardware_json + 28 legacy cols --
  const hw = row.hardware_snapshot;
  row.cpu_type = null; row.cpu_num = null;
  row.mem1_type = null; row.mem1_num = null; row.mem2_type = null; row.mem2_num = null;
  row.disk1_part = null; row.disk1_num = null; row.disk2_part = null; row.disk2_num = null;
  row.disk3_part = null; row.disk3_num = null; row.disk4_part = null; row.disk4_num = null;
  row.nic1_type = null; row.nic1_num = null; row.nic2_type = null; row.nic2_num = null;
  row.nic3_type = null; row.nic3_num = null; row.nic4_type = null; row.nic4_num = null;
  row.raid_type = null; row.raid_num = null;
  row.gpu1_type = null; row.gpu1_num = null; row.gpu2_type = null; row.gpu2_num = null;
  if (hw && Array.isArray(hw)) {
    row.hardware_json = JSON.stringify(hw);
    let cpuIdx = 0, memIdx = 0, diskIdx = 0, nicIdx = 0, raidIdx = 0, gpuIdx = 0;
    hw.forEach(item => {
      switch (item.type) {
        case 'cpu':
          if (cpuIdx === 0) { row.cpu_type = item.code; row.cpu_num = item.num; }
          cpuIdx++; break;
        case 'memory':
          if (memIdx === 0) { row.mem1_type = item.code; row.mem1_num = item.num; }
          else if (memIdx === 1) { row.mem2_type = item.code; row.mem2_num = item.num; }
          memIdx++; break;
        case 'disk':
          if (diskIdx === 0) { row.disk1_part = item.code; row.disk1_num = item.num; }
          else if (diskIdx === 1) { row.disk2_part = item.code; row.disk2_num = item.num; }
          else if (diskIdx === 2) { row.disk3_part = item.code; row.disk3_num = item.num; }
          else if (diskIdx === 3) { row.disk4_part = item.code; row.disk4_num = item.num; }
          diskIdx++; break;
        case 'network':
          if (nicIdx === 0) { row.nic1_type = item.code; row.nic1_num = item.num; }
          else if (nicIdx === 1) { row.nic2_type = item.code; row.nic2_num = item.num; }
          else if (nicIdx === 2) { row.nic3_type = item.code; row.nic3_num = item.num; }
          else if (nicIdx === 3) { row.nic4_type = item.code; row.nic4_num = item.num; }
          nicIdx++; break;
        case 'raid':
          if (raidIdx === 0) { row.raid_type = item.code; row.raid_num = item.num; }
          raidIdx++; break;
        case 'gpu':
          if (gpuIdx === 0) { row.gpu1_type = item.code; row.gpu1_num = item.num; }
          else if (gpuIdx === 1) { row.gpu2_type = item.code; row.gpu2_num = item.num; }
          gpuIdx++; break;
      }
    });
  } else {
    row.hardware_json = null;
  }

  // -- Network: network_snapshot [{ip,label}] → ips_json + 7 legacy cols --
  const net = row.network_snapshot;
  row.ip1 = null; row.ip2 = null; row.ip3 = null; row.ip4 = null;
  row.bmc = null; row.ib1 = null; row.ib2 = null;
  row.ips_json = null;
  if (net && Array.isArray(net)) {
    net.forEach(item => {
      if (item.label && item.ip) row[item.label] = item.ip;
    });
    const LABEL_TO_PURPOSE = { ip1: 'management', ip2: 'management', ip3: 'management', ip4: 'management', bmc: 'bmc', ib1: 'ib', ib2: 'ib' };
    const ipsItems = net.map(item => ({
      purpose: LABEL_TO_PURPOSE[item.label] || item.label,
      ip: item.ip
    }));
    if (ipsItems.length > 0) row.ips_json = JSON.stringify(ipsItems);
  }

  // -- Credentials: credentials_snapshot [{type,username,password?}] → credentials_json + 3 legacy cols --
  const cred = row.credentials_snapshot;
  row.credential_root = null; row.credential_etc1 = null; row.credential_etc2 = null;
  row.credentials_json = null;
  if (cred && Array.isArray(cred)) {
    row.credentials_json = JSON.stringify(cred);
    let etcIdx = 0;
    cred.forEach(item => {
      const pair = (item.username || '') + ' / ' + (item.password || '');
      if (item.type === 'root' && !row.credential_root) {
        row.credential_root = pair;
      } else {
        if (etcIdx === 0) { row.credential_etc1 = pair; etcIdx++; }
        else if (etcIdx === 1) { row.credential_etc2 = pair; etcIdx++; }
      }
    });
  }

  // -- Date: event_type별 분기 --
  if (row.event_type === 'returned') {
    row.return_date = row.event_date;
    row.usage_date = null;
  } else {
    row.usage_date = row.event_date;
    row.return_date = null;
  }

  // -- Status: event_type → Korean status --
  row.status = EVENT_TYPE_LABEL[row.event_type] || row.event_type;

  return row;
}

// ─── JSONB Helper: v1-style input → v2 JSONB snapshots ───
function buildSnapshots(data) {
  const result = { hardware_snapshot: null, network_snapshot: null, credentials_snapshot: null };

  // Hardware
  if (data.hardware_snapshot) {
    result.hardware_snapshot = typeof data.hardware_snapshot === 'string'
      ? JSON.parse(data.hardware_snapshot) : data.hardware_snapshot;
  } else if (data.hardware_json) {
    try { result.hardware_snapshot = JSON.parse(data.hardware_json); } catch (e) { /* ignore */ }
  } else {
    const items = [];
    if (data.cpu_type) items.push({ type: 'cpu', code: data.cpu_type, num: parseInt(data.cpu_num) || 0 });
    if (data.mem1_type) items.push({ type: 'memory', code: data.mem1_type, num: parseInt(data.mem1_num) || 0 });
    if (data.mem2_type) items.push({ type: 'memory', code: data.mem2_type, num: parseInt(data.mem2_num) || 0 });
    if (data.disk1_part) items.push({ type: 'disk', code: data.disk1_part, num: parseInt(data.disk1_num) || 0 });
    if (data.disk2_part) items.push({ type: 'disk', code: data.disk2_part, num: parseInt(data.disk2_num) || 0 });
    if (data.disk3_part) items.push({ type: 'disk', code: data.disk3_part, num: parseInt(data.disk3_num) || 0 });
    if (data.disk4_part) items.push({ type: 'disk', code: data.disk4_part, num: parseInt(data.disk4_num) || 0 });
    if (data.nic1_type) items.push({ type: 'network', code: data.nic1_type, num: parseInt(data.nic1_num) || 0 });
    if (data.nic2_type) items.push({ type: 'network', code: data.nic2_type, num: parseInt(data.nic2_num) || 0 });
    if (data.nic3_type) items.push({ type: 'network', code: data.nic3_type, num: parseInt(data.nic3_num) || 0 });
    if (data.nic4_type) items.push({ type: 'network', code: data.nic4_type, num: parseInt(data.nic4_num) || 0 });
    if (data.raid_type) items.push({ type: 'raid', code: data.raid_type, num: parseInt(data.raid_num) || 0 });
    if (data.gpu1_type) items.push({ type: 'gpu', code: data.gpu1_type, num: parseInt(data.gpu1_num) || 0 });
    if (data.gpu2_type) items.push({ type: 'gpu', code: data.gpu2_type, num: parseInt(data.gpu2_num) || 0 });
    if (items.length > 0) result.hardware_snapshot = items;
  }

  // Network
  if (data.network_snapshot) {
    result.network_snapshot = typeof data.network_snapshot === 'string'
      ? JSON.parse(data.network_snapshot) : data.network_snapshot;
  } else if (data.ips_json) {
    try {
      const parsed = JSON.parse(data.ips_json);
      const PURPOSE_TO_LABEL = { management: 'ip', bmc: 'bmc', ib: 'ib' };
      const ipCount = { ip: 0, ib: 0 };
      result.network_snapshot = parsed.map(item => {
        const base = PURPOSE_TO_LABEL[item.purpose] || item.purpose;
        if (base === 'ip') { ipCount.ip++; return { ip: item.ip, label: 'ip' + ipCount.ip }; }
        if (base === 'ib') { ipCount.ib++; return { ip: item.ip, label: 'ib' + ipCount.ib }; }
        return { ip: item.ip, label: base };
      });
    } catch (e) { /* ignore */ }
  } else {
    const items = [];
    if (data.ip1) items.push({ ip: data.ip1, label: 'ip1' });
    if (data.ip2) items.push({ ip: data.ip2, label: 'ip2' });
    if (data.ip3) items.push({ ip: data.ip3, label: 'ip3' });
    if (data.ip4) items.push({ ip: data.ip4, label: 'ip4' });
    if (data.bmc) items.push({ ip: data.bmc, label: 'bmc' });
    if (data.ib1) items.push({ ip: data.ib1, label: 'ib1' });
    if (data.ib2) items.push({ ip: data.ib2, label: 'ib2' });
    if (items.length > 0) result.network_snapshot = items;
  }

  // Credentials
  if (data.credentials_snapshot) {
    result.credentials_snapshot = typeof data.credentials_snapshot === 'string'
      ? JSON.parse(data.credentials_snapshot) : data.credentials_snapshot;
  } else if (data.credentials_json) {
    try { result.credentials_snapshot = JSON.parse(data.credentials_json); } catch (e) { /* ignore */ }
  } else {
    const items = [];
    if (data.credential_root) {
      const p = data.credential_root.split('/');
      items.push({ type: 'root', username: (p[0] || '').trim(), password: (p[1] || '').trim() });
    }
    if (data.credential_etc1) {
      const p = data.credential_etc1.split('/');
      items.push({ type: 'etc', username: (p[0] || '').trim(), password: (p[1] || '').trim() });
    }
    if (data.credential_etc2) {
      const p = data.credential_etc2.split('/');
      items.push({ type: 'etc', username: (p[0] || '').trim(), password: (p[1] || '').trim() });
    }
    if (items.length > 0) result.credentials_snapshot = items;
  }

  return result;
}

// Apply flatten + date fix to a single row
function processRow(row) {
  if (!row) return row;
  flattenSnapshot(row);
  fixRowDates(row, ['event_date', 'usage_date', 'return_date'],
    ['event_date', 'usage_date', 'return_date', 'created_at']);
  return row;
}

const EquipmentUsageLog = {
  // ═══════════════════════════════════════════════════
  // Existing methods (B-4b dashboard — unchanged)
  // ═══════════════════════════════════════════════════

  async getRecent(limit = 10) {
    const { rows } = await pool.query(
      `SELECT *,
              event_date as usage_date
       FROM equipment_usage_logs
       ORDER BY COALESCE(event_date, created_at) DESC, id DESC
       LIMIT $1`, [limit]
    );
    // Fix DATE columns + map event_type to Korean 'status' for view compatibility
    return rows.map(r => {
      fixRowDates(r, ['event_date', 'usage_date'], ['event_date', 'usage_date', 'created_at']);
      return { ...r, status: EVENT_TYPE_LABEL[r.event_type] || r.event_type };
    });
  },

  async countByStatus() {
    const { rows } = await pool.query(
      'SELECT event_type, COUNT(*) as count FROM equipment_usage_logs GROUP BY event_type'
    );
    const result = { total: 0 };
    rows.forEach(r => {
      const label = EVENT_TYPE_LABEL[r.event_type] || r.event_type;
      result[label] = parseInt(r.count);
      result.total += parseInt(r.count);
    });
    return result;
  },

  async getMonthlyTrend() {
    const { rows } = await pool.query(
      `SELECT TO_CHAR(COALESCE(event_date, created_at), 'YYYY-MM') as month,
              event_type, COUNT(*) as count
       FROM equipment_usage_logs
       WHERE COALESCE(event_date, created_at) >= CURRENT_DATE - INTERVAL '6 months'
       GROUP BY month, event_type
       ORDER BY month`
    );
    // Map event_type to Korean 'status' for view compatibility
    return rows.map(r => ({
      ...r,
      status: EVENT_TYPE_LABEL[r.event_type] || r.event_type
    }));
  },

  // ═══════════════════════════════════════════════════
  // Read methods (B-4d-6a — inventory route용)
  // ═══════════════════════════════════════════════════

  async findAllEquipment(filters = {}) {
    let sql = 'SELECT * FROM equipment_usage_logs e WHERE NOT EXISTS (SELECT 1 FROM module_inventory WHERE item_code = e.management_number)';
    const params = [];
    let idx = 1;

    if (filters.status) {
      const et = STATUS_TO_EVENT[filters.status] || filters.status;
      sql += ` AND e.event_type = $${idx++}`;
      params.push(et);
    }
    if (filters.room) {
      sql += ` AND e.room = $${idx++}`;
      params.push(filters.room);
    }
    if (filters.user_name) {
      sql += ` AND e.user_name = $${idx++}`;
      params.push(filters.user_name);
    }
    if (filters.date_from) {
      sql += ` AND e.event_date >= $${idx++}`;
      params.push(filters.date_from);
    }
    if (filters.date_to) {
      sql += ` AND e.event_date <= $${idx++}`;
      params.push(filters.date_to);
    }
    if (filters.ownership) {
      sql += ` AND e.ownership = $${idx++}`;
      params.push(filters.ownership);
    }
    if (filters.search) {
      sql += ` AND (e.management_number ILIKE $${idx} OR e.model_name ILIKE $${idx} OR e.user_name ILIKE $${idx} OR e.test_name ILIKE $${idx} OR e.asset_number ILIKE $${idx} OR e.notes ILIKE $${idx})`;
      params.push('%' + filters.search + '%');
      idx++;
    }

    sql += ' ORDER BY COALESCE(e.event_date, e.created_at) DESC, e.id DESC';
    const { rows } = await pool.query(sql, params);
    return rows.map(processRow);
  },

  async countByStatusEquipment() {
    const { rows } = await pool.query(`
      SELECT e.event_type, COUNT(*) as count FROM equipment_usage_logs e
      WHERE NOT EXISTS (SELECT 1 FROM module_inventory WHERE item_code = e.management_number)
      GROUP BY e.event_type
    `);
    const result = { total: 0 };
    rows.forEach(r => {
      const label = EVENT_TYPE_LABEL[r.event_type] || r.event_type;
      result[label] = parseInt(r.count);
      result.total += parseInt(r.count);
    });
    return result;
  },

  async getRoomsEquipment() {
    const { rows } = await pool.query(`
      SELECT DISTINCT e.room FROM equipment_usage_logs e
      WHERE e.room IS NOT NULL AND e.room != ''
        AND NOT EXISTS (SELECT 1 FROM module_inventory WHERE item_code = e.management_number)
      ORDER BY e.room
    `);
    return rows.map(r => r.room);
  },

  async getUsersEquipment() {
    const { rows } = await pool.query(`
      SELECT DISTINCT e.user_name FROM equipment_usage_logs e
      WHERE e.user_name IS NOT NULL AND e.user_name != ''
        AND NOT EXISTS (SELECT 1 FROM module_inventory WHERE item_code = e.management_number)
      ORDER BY e.user_name
    `);
    return rows.map(r => r.user_name);
  },

  async getLatestByManagement(mgmt) {
    const { rows } = await pool.query(`
      SELECT * FROM equipment_usage_logs
      WHERE management_number = $1
      ORDER BY COALESCE(event_date, created_at) DESC, id DESC
      LIMIT 1
    `, [mgmt]);
    return processRow(rows[0] || null);
  },

  async getHistory(mgmt) {
    const { rows } = await pool.query(`
      SELECT * FROM equipment_usage_logs
      WHERE management_number = $1
      ORDER BY COALESCE(event_date, created_at) ASC, id ASC
    `, [mgmt]);
    return rows.map(processRow);
  },

  async findById(id) {
    const { rows } = await pool.query(
      'SELECT * FROM equipment_usage_logs WHERE id = $1', [id]
    );
    return processRow(rows[0] || null);
  },

  // ═══════════════════════════════════════════════════
  // Write methods (B-4d-6a — 설계 §5 하이브리드)
  // ═══════════════════════════════════════════════════

  // INSERT new event. status→event_type 자동매핑.
  async create(data) {
    const eventType = STATUS_TO_EVENT[data.status] || data.event_type || 'in_use';
    const eventDate = data.usage_date || data.event_date || null;
    const snaps = buildSnapshots(data);

    const { rows } = await pool.query(`
      INSERT INTO equipment_usage_logs
        (event_type, event_date, asset_id, management_number, asset_number, model_name,
         user_name, test_name, test_detail, room, rack, unit,
         hardware_snapshot, network_snapshot, credentials_snapshot,
         ownership, os, notes, created_by)
      VALUES ($1, COALESCE($2::date, CURRENT_DATE), $3, $4, $5, $6,
              $7, $8, $9, $10, $11, $12,
              $13::jsonb, $14::jsonb, $15::jsonb,
              $16, $17, $18, $19)
      RETURNING id
    `, [
      eventType,
      eventDate,
      data.asset_id || null,
      data.management_number || null,
      data.asset_number || null,
      data.model_name || null,
      data.user_name || null,
      data.test_name || null,
      data.test_detail || null,
      data.room || null,
      data.rack || null,
      data.unit || null,
      snaps.hardware_snapshot ? JSON.stringify(snaps.hardware_snapshot) : null,
      snaps.network_snapshot ? JSON.stringify(snaps.network_snapshot) : null,
      snaps.credentials_snapshot ? JSON.stringify(snaps.credentials_snapshot) : null,
      data.ownership || 'company',
      data.os || null,
      data.notes || null,
      data.created_by || null
    ]);
    return rows[0].id;
  },

  // ★ Append: 원본(id) 조회 → 동일 mgmt로 'returned' 이벤트 INSERT (UPDATE 아님)
  async markReturned(id, returnDate) {
    const { rows: orig } = await pool.query(
      'SELECT * FROM equipment_usage_logs WHERE id = $1', [id]
    );
    if (!orig[0]) return;
    const o = orig[0];
    const date = returnDate || new Date().toISOString().split('T')[0];

    await pool.query(`
      INSERT INTO equipment_usage_logs
        (event_type, event_date, asset_id, management_number, asset_number, model_name,
         user_name, test_name, test_detail, room, rack, unit,
         hardware_snapshot, network_snapshot, credentials_snapshot,
         ownership, os, notes, created_by)
      VALUES ('returned', $1::date, $2, $3, $4, $5,
              $6, $7, $8, $9, $10, $11,
              $12::jsonb, $13::jsonb, $14::jsonb,
              $15, $16, $17, $18)
    `, [
      date,
      o.asset_id, o.management_number, o.asset_number, o.model_name,
      o.user_name, o.test_name, o.test_detail,
      o.room, o.rack, o.unit,
      o.hardware_snapshot ? JSON.stringify(o.hardware_snapshot) : null,
      o.network_snapshot ? JSON.stringify(o.network_snapshot) : null,
      o.credentials_snapshot ? JSON.stringify(o.credentials_snapshot) : null,
      o.ownership, o.os,
      '반납처리',
      o.created_by
    ]);
  },

  // ★ Append: mgmt별 최신 in_use 이벤트 찾아 → 'returned' 이벤트 INSERT
  async returnActiveByManagement(mgmt, returnDate) {
    const { rows } = await pool.query(`
      SELECT * FROM equipment_usage_logs
      WHERE management_number = $1 AND event_type = 'in_use'
      ORDER BY id DESC LIMIT 1
    `, [mgmt]);
    if (!rows[0]) return;
    const o = rows[0];
    const date = returnDate || new Date().toISOString().split('T')[0];

    await pool.query(`
      INSERT INTO equipment_usage_logs
        (event_type, event_date, asset_id, management_number, asset_number, model_name,
         user_name, test_name, test_detail, room, rack, unit,
         hardware_snapshot, network_snapshot, credentials_snapshot,
         ownership, os, notes, created_by)
      VALUES ('returned', $1::date, $2, $3, $4, $5,
              $6, $7, $8, $9, $10, $11,
              $12::jsonb, $13::jsonb, $14::jsonb,
              $15, $16, $17, $18)
    `, [
      date,
      o.asset_id, o.management_number, o.asset_number, o.model_name,
      o.user_name, o.test_name, o.test_detail,
      o.room, o.rack, o.unit,
      o.hardware_snapshot ? JSON.stringify(o.hardware_snapshot) : null,
      o.network_snapshot ? JSON.stringify(o.network_snapshot) : null,
      o.credentials_snapshot ? JSON.stringify(o.credentials_snapshot) : null,
      o.ownership, o.os,
      '자동반납처리',
      o.created_by
    ]);
  },

  // UPDATE (내용정정, 상태전이 아님). event_type 변경 시 status→event_type 치환.
  async update(id, data) {
    const snaps = buildSnapshots(data);
    const eventType = data.status
      ? (STATUS_TO_EVENT[data.status] || data.event_type || null)
      : (data.event_type || null);
    const eventDate = data.usage_date || data.event_date || null;

    await pool.query(`
      UPDATE equipment_usage_logs SET
        event_type = COALESCE($1, event_type),
        event_date = COALESCE($2::date, event_date),
        management_number = $3,
        asset_number = $4,
        model_name = $5,
        user_name = $6,
        test_name = $7,
        test_detail = $8,
        room = $9,
        rack = $10,
        unit = $11,
        hardware_snapshot = COALESCE($12::jsonb, hardware_snapshot),
        network_snapshot = COALESCE($13::jsonb, network_snapshot),
        credentials_snapshot = COALESCE($14::jsonb, credentials_snapshot),
        ownership = COALESCE($15, ownership),
        os = $16,
        notes = $17
      WHERE id = $18
    `, [
      eventType,
      eventDate,
      data.management_number || null,
      data.asset_number || null,
      data.model_name || null,
      data.user_name || null,
      data.test_name || null,
      data.test_detail || null,
      data.room || null,
      data.rack || null,
      data.unit || null,
      snaps.hardware_snapshot ? JSON.stringify(snaps.hardware_snapshot) : null,
      snaps.network_snapshot ? JSON.stringify(snaps.network_snapshot) : null,
      snaps.credentials_snapshot ? JSON.stringify(snaps.credentials_snapshot) : null,
      data.ownership || null,
      data.os || null,
      data.notes || null,
      id
    ]);
  },

  // DELETE (v1대로 충실이식)
  async delete(id) {
    await pool.query('DELETE FROM equipment_usage_logs WHERE id = $1', [id]);
  }
};

module.exports = EquipmentUsageLog;
