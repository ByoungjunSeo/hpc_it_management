const { getDb } = require('../config/database');

const ModuleInventory = {
  findAll(moduleType) {
    let sql = 'SELECT * FROM module_inventory';
    const params = [];
    if (moduleType) {
      sql += ' WHERE module_type = ?';
      params.push(moduleType);
    }
    sql += ' ORDER BY module_type, item_code';
    return getDb().prepare(sql).all(...params);
  },

  getStatsByType() {
    return getDb().prepare(`
      SELECT module_type,
        COUNT(*) as item_count,
        SUM(total_quantity) as total,
        SUM(in_use_quantity) as in_use,
        SUM(spare_quantity) as spare,
        SUM(storage_quantity) as storage
      FROM module_inventory
      GROUP BY module_type
      ORDER BY module_type
    `).all();
  },

  findByCode(itemCode) {
    return getDb().prepare('SELECT * FROM module_inventory WHERE item_code = ?').get(itemCode);
  },

  getUsageByCode(itemCode) {
    // computing_modules에서 직접 사용 현황 조회 (specification 직접 매칭 + model 폴백)
    const db = getDb();
    const mi = db.prepare('SELECT model, module_type FROM module_inventory WHERE item_code = ?').get(itemCode);

    let conditions = 'cm.specification = ?';
    const params = [itemCode];
    if (mi && mi.model) {
      conditions += " OR ((cm.specification IS NULL OR cm.specification = '') AND cm.module_type = ? AND cm.model = ?)";
      params.push(mi.module_type, mi.model);
    }

    const rows = db.prepare(`
      SELECT cm.id, cm.count, cm.module_type, cm.asset_id,
             a.management_number, a.model_name
      FROM computing_modules cm
      JOIN assets a ON cm.asset_id = a.id
      WHERE (cm.owner IS NULL OR cm.owner = 'company')
        AND a.status = 'active'
        AND (${conditions})
      ORDER BY a.management_number
    `).all(...params);

    return rows.map(row => {
      const log = db.prepare(
        "SELECT user_name, room, rack, unit FROM equipment_usage_logs WHERE management_number = ? AND status = '사용중' ORDER BY id DESC LIMIT 1"
      ).get(row.management_number);
      return {
        id: row.id,
        management_number: row.management_number,
        model_name: row.model_name,
        user_name: log ? log.user_name : null,
        status: '사용중',
        location: log ? [log.room, log.rack, log.unit].filter(Boolean).join('/') : '',
        slot: row.module_type ? row.module_type.toUpperCase() : '',
        count: row.count || 1
      };
    });
  },

  recalculateInUse() {
    // computing_modules에서 직접 사용량 집계 (자사 모듈만, 활성 자산만)
    const db = getDb();

    // 1) specification이 설정된 모듈: 직접 매칭
    const directRows = db.prepare(`
      SELECT cm.specification as item_code, SUM(cm.count) as total_count
      FROM computing_modules cm
      JOIN assets a ON cm.asset_id = a.id
      WHERE cm.specification IS NOT NULL
        AND cm.specification != ''
        AND (cm.owner IS NULL OR cm.owner = 'company')
        AND a.status = 'active'
      GROUP BY cm.specification
    `).all();

    // 2) specification이 비어있는 모듈: module_type + model로 module_inventory 매칭
    const fallbackRows = db.prepare(`
      SELECT mi.item_code, SUM(cm.count) as total_count
      FROM computing_modules cm
      JOIN assets a ON cm.asset_id = a.id
      JOIN module_inventory mi ON mi.module_type = cm.module_type AND mi.model = cm.model
      WHERE (cm.specification IS NULL OR cm.specification = '')
        AND cm.model IS NOT NULL AND cm.model != ''
        AND (cm.owner IS NULL OR cm.owner = 'company')
        AND a.status = 'active'
      GROUP BY mi.item_code
    `).all();

    const usageMap = {};
    for (const row of directRows) {
      usageMap[row.item_code] = (usageMap[row.item_code] || 0) + row.total_count;
    }
    for (const row of fallbackRows) {
      usageMap[row.item_code] = (usageMap[row.item_code] || 0) + row.total_count;
    }

    const updateStmt = db.prepare(`
      UPDATE module_inventory
      SET in_use_quantity = ?,
          storage_quantity = MAX(0, total_quantity - ?),
          spare_quantity = MAX(0, total_quantity - ?),
          updated_at = CURRENT_TIMESTAMP
      WHERE item_code = ?
    `);

    const tx = db.transaction(() => {
      // Reset: in_use=0, storage=total, spare=total
      db.prepare(`
        UPDATE module_inventory
        SET in_use_quantity = 0,
            storage_quantity = total_quantity,
            spare_quantity = total_quantity
      `).run();

      for (const [code, count] of Object.entries(usageMap)) {
        updateStmt.run(count, count, count, code);
      }
    });
    tx();
  },

  findById(id) {
    return getDb().prepare('SELECT * FROM module_inventory WHERE id = ?').get(id);
  },

  updateField(id, field, value) {
    const allowed = ['manufacturer', 'model', 'capacity', 'specification', 'asset_number', 'label'];
    if (!allowed.includes(field)) throw new Error('수정할 수 없는 필드: ' + field);
    return getDb().prepare(
      `UPDATE module_inventory SET ${field} = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).run(value || null, id);
  },

  getNextCodeInfo(moduleType) {
    const prefixMap = {
      cpu:     { prefix: 'CPU-',   format: 'CPU-[A-Z]',        example: 'CPU-A' },
      memory:  { prefix: 'mem-',   format: 'mem-[용량]-[A-Z]', example: 'mem-16-A' },
      disk:    { prefix: 'sto-',   format: 'sto-[용량]-[A-Z]', example: 'sto-300G-A' },
      network: { prefix: 'net-',   format: 'net-[속도]-[A-Z]', example: 'net-10-A' },
      raid:    { prefix: 'raid-',  format: 'raid-[A-Z]',       example: 'raid-A' },
      gpu:     { prefix: 'GPU-',   format: 'GPU-[용량]-[A-Z]', example: 'GPU-16G-A' },
      cable:   { prefix: 'cab-',   format: 'cab-[대역폭]-[A-Z]', example: 'cab-100G-A' }
    };

    const info = prefixMap[moduleType];
    if (!info) return null;

    const items = this.findAll(moduleType);
    const codes = items.map(i => i.item_code).filter(Boolean);

    // Parse last uppercase letter suffix from each code to find the max
    let maxSuffix = null;
    for (const code of codes) {
      const match = code.match(/-([A-Z])$/);
      if (match) {
        const ch = match[1];
        if (!maxSuffix || ch > maxSuffix) maxSuffix = ch;
      }
    }

    let nextSuffix = 'A';
    if (maxSuffix) {
      nextSuffix = maxSuffix < 'Z' ? String.fromCharCode(maxSuffix.charCodeAt(0) + 1) : 'Z+';
    }

    // Build suggested next code using the format pattern
    let nextCode;
    if (['cpu', 'raid'].includes(moduleType)) {
      nextCode = info.prefix + nextSuffix;
    } else {
      // For types with capacity/speed part, show placeholder
      nextCode = info.prefix + '…-' + nextSuffix;
    }

    return {
      ...info,
      codes,
      nextSuffix,
      nextCode
    };
  },

  findStorageModules() {
    return getDb().prepare(`
      SELECT * FROM module_inventory
      ORDER BY module_type, item_code
    `).all();
  },

  adjustQuantity(id, quantityChange) {
    const db = getDb();
    const item = db.prepare('SELECT * FROM module_inventory WHERE id = ?').get(id);
    if (!item) throw new Error('부품을 찾을 수 없습니다.');
    const newTotal = Math.max(0, item.total_quantity + quantityChange);
    const newSpare = Math.max(0, newTotal - item.in_use_quantity);
    const newStorage = Math.max(0, newTotal - item.in_use_quantity);
    db.prepare(`
      UPDATE module_inventory
      SET total_quantity = ?, spare_quantity = ?, storage_quantity = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(newTotal, newSpare, newStorage, id);
    return { before_total: item.total_quantity, after_total: newTotal, before_spare: item.spare_quantity, after_spare: newSpare };
  },

  upsert(data) {
    return getDb().prepare(`
      INSERT INTO module_inventory (module_type, item_code, label, manufacturer, model, capacity, specification,
        total_quantity, in_use_quantity, spare_quantity, storage_quantity, asset_number, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(item_code) DO UPDATE SET
        module_type=excluded.module_type, label=excluded.label, manufacturer=excluded.manufacturer,
        model=excluded.model, capacity=excluded.capacity, specification=excluded.specification,
        total_quantity=excluded.total_quantity, in_use_quantity=excluded.in_use_quantity,
        spare_quantity=excluded.spare_quantity, storage_quantity=excluded.storage_quantity,
        asset_number=COALESCE(excluded.asset_number, module_inventory.asset_number),
        updated_at=CURRENT_TIMESTAMP
    `).run(
      data.module_type, data.item_code, data.label || null,
      data.manufacturer || null, data.model || null,
      data.capacity || null, data.specification || null,
      data.total_quantity || 0, data.in_use_quantity || 0, data.spare_quantity || 0,
      data.storage_quantity ?? data.spare_quantity ?? 0,
      data.asset_number || null
    );
  }
};

module.exports = ModuleInventory;
