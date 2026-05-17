const { getDb } = require('../config/database');

const EquipmentUsageLog = {
  findAll(filters = {}) {
    let sql = 'SELECT * FROM equipment_usage_logs WHERE 1=1';
    const params = [];

    if (filters.status) {
      sql += ' AND status = ?';
      params.push(filters.status);
    }
    if (filters.room) {
      sql += ' AND room = ?';
      params.push(filters.room);
    }
    if (filters.user_name) {
      sql += ' AND user_name = ?';
      params.push(filters.user_name);
    }
    if (filters.date_from) {
      sql += ' AND (usage_date >= ? OR return_date >= ?)';
      params.push(filters.date_from, filters.date_from);
    }
    if (filters.date_to) {
      sql += ' AND (usage_date <= ? OR return_date <= ?)';
      params.push(filters.date_to, filters.date_to);
    }
    if (filters.ownership) {
      sql += ' AND ownership = ?';
      params.push(filters.ownership);
    }
    if (filters.search) {
      sql += ' AND (management_number LIKE ? OR model_name LIKE ? OR user_name LIKE ? OR test_name LIKE ? OR asset_number LIKE ? OR notes LIKE ?)';
      const s = '%' + filters.search + '%';
      params.push(s, s, s, s, s, s);
    }

    sql += ' ORDER BY CASE WHEN usage_date IS NOT NULL THEN usage_date ELSE created_at END DESC, id DESC';
    return getDb().prepare(sql).all(...params);
  },

  findById(id) {
    return getDb().prepare('SELECT * FROM equipment_usage_logs WHERE id = ?').get(id);
  },

  getHistory(managementNumber) {
    return getDb().prepare(`
      SELECT * FROM equipment_usage_logs
      WHERE management_number = ?
      ORDER BY COALESCE(usage_date, return_date, created_at) ASC, id ASC
    `).all(managementNumber);
  },

  countByStatus() {
    const rows = getDb().prepare(`
      SELECT status, COUNT(*) as count FROM equipment_usage_logs GROUP BY status
    `).all();
    const result = { total: 0 };
    rows.forEach(r => {
      result[r.status] = r.count;
      result.total += r.count;
    });
    return result;
  },

  getRooms() {
    return getDb().prepare(`
      SELECT DISTINCT room FROM equipment_usage_logs WHERE room IS NOT NULL AND room != '' ORDER BY room
    `).all().map(r => r.room);
  },

  getUsers() {
    return getDb().prepare(`
      SELECT DISTINCT user_name FROM equipment_usage_logs WHERE user_name IS NOT NULL AND user_name != '' ORDER BY user_name
    `).all().map(r => r.user_name);
  },

  create(data) {
    const stmt = getDb().prepare(`
      INSERT INTO equipment_usage_logs (
        usage_date, return_date, asset_number, management_number, model_name,
        user_name, test_name, test_detail,
        credential_root, credential_etc1, credential_etc2,
        ip1, ip2, ip3, ip4, bmc, ib1, ib2,
        room, rack, unit,
        cpu_type, cpu_num, mem1_type, mem1_num, mem2_type, mem2_num,
        disk1_part, disk1_num, disk2_part, disk2_num, disk3_part, disk3_num, disk4_part, disk4_num,
        nic1_type, nic1_num, nic2_type, nic2_num, nic3_type, nic3_num, nic4_type, nic4_num,
        raid_type, raid_num, gpu1_type, gpu1_num, gpu2_type, gpu2_num,
        os, notes, ownership, status, hardware_json, credentials_json, ips_json
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `);
    const result = stmt.run(
      data.usage_date || null, data.return_date || null,
      data.asset_number || null, data.management_number || null, data.model_name || null,
      data.user_name || null, data.test_name || null, data.test_detail || null,
      data.credential_root || null, data.credential_etc1 || null, data.credential_etc2 || null,
      data.ip1 || null, data.ip2 || null, data.ip3 || null, data.ip4 || null,
      data.bmc || null, data.ib1 || null, data.ib2 || null,
      data.room || null, data.rack || null, data.unit || null,
      data.cpu_type || null, parseInt(data.cpu_num) || null,
      data.mem1_type || null, parseInt(data.mem1_num) || null,
      data.mem2_type || null, parseInt(data.mem2_num) || null,
      data.disk1_part || null, parseInt(data.disk1_num) || null,
      data.disk2_part || null, parseInt(data.disk2_num) || null,
      data.disk3_part || null, parseInt(data.disk3_num) || null,
      data.disk4_part || null, parseInt(data.disk4_num) || null,
      data.nic1_type || null, parseInt(data.nic1_num) || null,
      data.nic2_type || null, parseInt(data.nic2_num) || null,
      data.nic3_type || null, parseInt(data.nic3_num) || null,
      data.nic4_type || null, parseInt(data.nic4_num) || null,
      data.raid_type || null, parseInt(data.raid_num) || null,
      data.gpu1_type || null, parseInt(data.gpu1_num) || null,
      data.gpu2_type || null, parseInt(data.gpu2_num) || null,
      data.os || null, data.notes || null,
      data.ownership || 'company',
      data.status || '사용중',
      data.hardware_json || null,
      data.credentials_json || null,
      data.ips_json || null
    );
    return result.lastInsertRowid;
  },

  update(id, data) {
    const stmt = getDb().prepare(`
      UPDATE equipment_usage_logs SET
        usage_date=?, return_date=?, asset_number=?, management_number=?, model_name=?,
        user_name=?, test_name=?, test_detail=?,
        credential_root=?, credential_etc1=?, credential_etc2=?,
        ip1=?, ip2=?, ip3=?, ip4=?, bmc=?, ib1=?, ib2=?,
        room=?, rack=?, unit=?,
        cpu_type=?, cpu_num=?, mem1_type=?, mem1_num=?, mem2_type=?, mem2_num=?,
        disk1_part=?, disk1_num=?, disk2_part=?, disk2_num=?, disk3_part=?, disk3_num=?, disk4_part=?, disk4_num=?,
        nic1_type=?, nic1_num=?, nic2_type=?, nic2_num=?, nic3_type=?, nic3_num=?, nic4_type=?, nic4_num=?,
        raid_type=?, raid_num=?, gpu1_type=?, gpu1_num=?, gpu2_type=?, gpu2_num=?,
        os=?, notes=?, ownership=?, status=?, hardware_json=?, credentials_json=?, ips_json=?,
        updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `);
    return stmt.run(
      data.usage_date || null, data.return_date || null,
      data.asset_number || null, data.management_number || null, data.model_name || null,
      data.user_name || null, data.test_name || null, data.test_detail || null,
      data.credential_root || null, data.credential_etc1 || null, data.credential_etc2 || null,
      data.ip1 || null, data.ip2 || null, data.ip3 || null, data.ip4 || null,
      data.bmc || null, data.ib1 || null, data.ib2 || null,
      data.room || null, data.rack || null, data.unit || null,
      data.cpu_type || null, parseInt(data.cpu_num) || null,
      data.mem1_type || null, parseInt(data.mem1_num) || null,
      data.mem2_type || null, parseInt(data.mem2_num) || null,
      data.disk1_part || null, parseInt(data.disk1_num) || null,
      data.disk2_part || null, parseInt(data.disk2_num) || null,
      data.disk3_part || null, parseInt(data.disk3_num) || null,
      data.disk4_part || null, parseInt(data.disk4_num) || null,
      data.nic1_type || null, parseInt(data.nic1_num) || null,
      data.nic2_type || null, parseInt(data.nic2_num) || null,
      data.nic3_type || null, parseInt(data.nic3_num) || null,
      data.nic4_type || null, parseInt(data.nic4_num) || null,
      data.raid_type || null, parseInt(data.raid_num) || null,
      data.gpu1_type || null, parseInt(data.gpu1_num) || null,
      data.gpu2_type || null, parseInt(data.gpu2_num) || null,
      data.os || null, data.notes || null,
      data.ownership || 'company', data.status || '입고',
      data.hardware_json || null,
      data.credentials_json || null,
      data.ips_json || null,
      id
    );
  },

  markReturned(id, returnDate) {
    return getDb().prepare(`
      UPDATE equipment_usage_logs SET return_date = ?, status = '반납완료', updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(returnDate || new Date().toISOString().split('T')[0], id);
  },

  returnActiveByManagement(managementNumber, returnDate) {
    return getDb().prepare(`
      UPDATE equipment_usage_logs SET return_date = ?, status = '반납완료', updated_at = CURRENT_TIMESTAMP
      WHERE management_number = ? AND status = '사용중'
    `).run(returnDate || new Date().toISOString().split('T')[0], managementNumber);
  },

  delete(id) {
    return getDb().prepare('DELETE FROM equipment_usage_logs WHERE id = ?').run(id);
  },

  getRecent(limit = 10) {
    return getDb().prepare(`
      SELECT * FROM equipment_usage_logs
      ORDER BY COALESCE(usage_date, return_date, created_at) DESC, id DESC
      LIMIT ?
    `).all(limit);
  },

  getLatestByManagement(managementNumber) {
    return getDb().prepare(`
      SELECT * FROM equipment_usage_logs
      WHERE management_number = ?
      ORDER BY COALESCE(usage_date, return_date, created_at) DESC, id DESC
      LIMIT 1
    `).get(managementNumber);
  },

  updateHardwareColumns(managementNumber, hardwareData) {
    const existing = this.getLatestByManagement(managementNumber);
    if (!existing || existing.status !== '사용중') return null;

    const fields = ['cpu_type','cpu_num','mem1_type','mem1_num','mem2_type','mem2_num',
      'disk1_part','disk1_num','disk2_part','disk2_num','disk3_part','disk3_num','disk4_part','disk4_num',
      'nic1_type','nic1_num','nic2_type','nic2_num','nic3_type','nic3_num','nic4_type','nic4_num',
      'raid_type','raid_num','gpu1_type','gpu1_num','gpu2_type','gpu2_num'];

    const setClauses = fields.map(f => `${f}=?`).join(', ');
    const values = fields.map(f => hardwareData[f] ?? existing[f] ?? null);

    getDb().prepare(`UPDATE equipment_usage_logs SET ${setClauses}, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(...values, existing.id);
    return existing.id;
  },

  getMonthlyTrend() {
    return getDb().prepare(
      `SELECT strftime('%Y-%m', COALESCE(usage_date, return_date, created_at)) as month,
              status, COUNT(*) as count
       FROM equipment_usage_logs
       WHERE COALESCE(usage_date, return_date, created_at) >= date('now', '-6 months')
       GROUP BY month, status
       ORDER BY month`
    ).all();
  },

  getComponentTypes() {
    return getDb().prepare('SELECT DISTINCT item_code, module_type, label, manufacturer, model, capacity, specification FROM module_inventory ORDER BY module_type, item_code').all();
  },

  findAllEquipment(filters = {}) {
    let sql = 'SELECT * FROM equipment_usage_logs e WHERE NOT EXISTS (SELECT 1 FROM module_inventory WHERE item_code = e.management_number)';
    const params = [];

    if (filters.status) {
      sql += ' AND e.status = ?';
      params.push(filters.status);
    }
    if (filters.room) {
      sql += ' AND e.room = ?';
      params.push(filters.room);
    }
    if (filters.user_name) {
      sql += ' AND e.user_name = ?';
      params.push(filters.user_name);
    }
    if (filters.date_from) {
      sql += ' AND (e.usage_date >= ? OR e.return_date >= ?)';
      params.push(filters.date_from, filters.date_from);
    }
    if (filters.date_to) {
      sql += ' AND (e.usage_date <= ? OR e.return_date <= ?)';
      params.push(filters.date_to, filters.date_to);
    }
    if (filters.ownership) {
      sql += ' AND e.ownership = ?';
      params.push(filters.ownership);
    }
    if (filters.search) {
      sql += ' AND (e.management_number LIKE ? OR e.model_name LIKE ? OR e.user_name LIKE ? OR e.test_name LIKE ? OR e.asset_number LIKE ? OR e.notes LIKE ?)';
      const s = '%' + filters.search + '%';
      params.push(s, s, s, s, s, s);
    }

    sql += ' ORDER BY CASE WHEN e.usage_date IS NOT NULL THEN e.usage_date ELSE e.created_at END DESC, e.id DESC';
    return getDb().prepare(sql).all(...params);
  },

  countByStatusEquipment() {
    const rows = getDb().prepare(`
      SELECT e.status, COUNT(*) as count FROM equipment_usage_logs e
      WHERE NOT EXISTS (SELECT 1 FROM module_inventory WHERE item_code = e.management_number)
      GROUP BY e.status
    `).all();
    const result = { total: 0 };
    rows.forEach(r => {
      result[r.status] = r.count;
      result.total += r.count;
    });
    return result;
  },

  getRoomsEquipment() {
    return getDb().prepare(`
      SELECT DISTINCT e.room FROM equipment_usage_logs e
      WHERE e.room IS NOT NULL AND e.room != ''
        AND NOT EXISTS (SELECT 1 FROM module_inventory WHERE item_code = e.management_number)
      ORDER BY e.room
    `).all().map(r => r.room);
  },

  getUsersEquipment() {
    return getDb().prepare(`
      SELECT DISTINCT e.user_name FROM equipment_usage_logs e
      WHERE e.user_name IS NOT NULL AND e.user_name != ''
        AND NOT EXISTS (SELECT 1 FROM module_inventory WHERE item_code = e.management_number)
      ORDER BY e.user_name
    `).all().map(r => r.user_name);
  }
};

module.exports = EquipmentUsageLog;
