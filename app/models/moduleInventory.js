const { getDb } = require('../config/database');

// ── Helper: parse item_code into numeric sort key for capacity-based ordering ──
function parseItemCodeSortKey(code) {
  // 업체 형식: {name}-{type}-{NNN} (구버전: {name}-부품-{type}-{NNN})
  let m = code.match(/-(?:부품-)?[^-]+-(\d+)$/);
  if (m) return parseInt(m[1]);

  // mem-{num}-{alpha}
  m = code.match(/^mem-(\d+)-/);
  if (m) return parseInt(m[1]);

  // sto-{num}{G|T}-{alpha}
  m = code.match(/^sto-([\d.]+)(G|T)-/);
  if (m) return parseFloat(m[1]) * (m[2] === 'T' ? 1024 : 1);

  // GPU-{num}G-{alpha}
  m = code.match(/^GPU-(\d+)G-/);
  if (m) return parseInt(m[1]);

  // net-{num}-{alpha}
  m = code.match(/^net-([\d.]+)-/);
  if (m) return parseFloat(m[1]);

  // cab-{num}G-{alpha}
  m = code.match(/^cab-(\d+)G-/);
  if (m) return parseInt(m[1]);

  // CPU-{alpha}, raid-{alpha}
  m = code.match(/^(?:CPU|raid)-([A-Z])$/i);
  if (m) return m[1].charCodeAt(0);

  return 0;
}

const ModuleInventory = {
  findAll(moduleType, owner) {
    let sql = 'SELECT * FROM module_inventory';
    const conditions = [];
    const params = [];
    if (moduleType) {
      conditions.push('module_type = ?');
      params.push(moduleType);
    }
    if (owner === 'company') {
      conditions.push("(owner IS NULL OR owner = 'company')");
    } else if (owner === 'vendor') {
      conditions.push("owner = 'vendor'");
    }
    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }
    sql += ' ORDER BY module_type, item_code';
    const results = getDb().prepare(sql).all(...params);
    return results.sort((a, b) => {
      if (a.module_type !== b.module_type) return a.module_type.localeCompare(b.module_type);
      const ka = parseItemCodeSortKey(a.item_code);
      const kb = parseItemCodeSortKey(b.item_code);
      if (ka !== kb) return ka - kb;
      return a.item_code.localeCompare(b.item_code);
    });
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
      WHERE a.status = 'active'
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
    // computing_modules에서 직접 사용량 집계 (자사+업체 모두, 활성 자산만)
    const db = getDb();

    // 1) specification이 설정된 모듈: 직접 매칭
    const directRows = db.prepare(`
      SELECT cm.specification as item_code, SUM(cm.count) as total_count
      FROM computing_modules cm
      JOIN assets a ON cm.asset_id = a.id
      WHERE cm.specification IS NOT NULL
        AND cm.specification != ''
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
          total_quantity = storage_quantity + ?,
          spare_quantity = storage_quantity,
          updated_at = CURRENT_TIMESTAMP
      WHERE item_code = ?
    `);

    const tx = db.transaction(() => {
      // Reset: in_use=0, total=storage, spare=storage
      db.prepare(`
        UPDATE module_inventory
        SET in_use_quantity = 0,
            total_quantity = storage_quantity,
            spare_quantity = storage_quantity
      `).run();

      for (const [code, count] of Object.entries(usageMap)) {
        updateStmt.run(count, count, code);
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
    const typeLabels = {
      cpu: 'CPU', memory: '메모리', disk: '스토리지', network: '네트워크',
      raid: 'RAID', gpu: 'GPU', cable: '케이블'
    };

    const typeName = typeLabels[moduleType];
    if (!typeName) return null;

    const items = this.findAll(moduleType);
    const codes = items.map(i => i.item_code).filter(Boolean);

    // Parse max sequential number per manufacturer prefix
    // Format: {제조사}-{유형}-{NNN} (구버전: {제조사}-부품-{유형}-{NNN})
    const newSuffix = '-' + typeName + '-';
    const oldSuffix = '-부품-' + typeName + '-';
    let maxNum = 0;
    const prefixCounts = {};
    for (const code of codes) {
      // 신규 형식 먼저, 구버전 형식도 지원
      let idx = code.lastIndexOf(newSuffix);
      let suffixLen = newSuffix.length;
      if (idx < 0 || code.indexOf(oldSuffix) >= 0) {
        const oldIdx = code.lastIndexOf(oldSuffix);
        if (oldIdx >= 0) { idx = oldIdx; suffixLen = oldSuffix.length; }
      }
      if (idx >= 0) {
        const numStr = code.substring(idx + suffixLen);
        const num = parseInt(numStr);
        if (!isNaN(num) && num > maxNum) maxNum = num;
        const mfrPrefix = code.substring(0, idx);
        prefixCounts[mfrPrefix] = (prefixCounts[mfrPrefix] || 0) + 1;
      }
    }

    const format = '{제조사}-' + typeName + '-{NNN}';
    const example = '삼성-' + typeName + '-001';

    return {
      prefix: newSuffix,
      format,
      example,
      codes,
      nextNum: maxNum + 1,
      nextCode: '{제조사}-' + typeName + '-' + String(maxNum + 1).padStart(3, '0'),
      prefixCounts
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
        total_quantity, in_use_quantity, spare_quantity, storage_quantity, asset_number,
        owner, owner_vendor_id, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(item_code) DO UPDATE SET
        module_type=excluded.module_type, label=excluded.label, manufacturer=excluded.manufacturer,
        model=excluded.model, capacity=excluded.capacity, specification=excluded.specification,
        total_quantity=excluded.total_quantity, in_use_quantity=excluded.in_use_quantity,
        spare_quantity=excluded.spare_quantity, storage_quantity=excluded.storage_quantity,
        asset_number=COALESCE(excluded.asset_number, module_inventory.asset_number),
        owner=COALESCE(excluded.owner, module_inventory.owner),
        owner_vendor_id=COALESCE(excluded.owner_vendor_id, module_inventory.owner_vendor_id),
        updated_at=CURRENT_TIMESTAMP
    `).run(
      data.module_type, data.item_code, data.label || null,
      data.manufacturer || null, data.model || null,
      data.capacity || null, data.specification || null,
      data.total_quantity || 0, data.in_use_quantity || 0, data.spare_quantity || 0,
      data.storage_quantity ?? data.spare_quantity ?? 0,
      data.asset_number || null,
      data.owner || 'company', data.owner_vendor_id || null
    );
  }
};

module.exports = ModuleInventory;
