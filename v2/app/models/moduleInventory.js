const { pool } = require('../config/database');

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
  async findAll(moduleType, owner) {
    let sql = 'SELECT * FROM module_inventory';
    const conditions = [];
    const params = [];
    let idx = 1;
    if (moduleType) {
      conditions.push(`module_type = $${idx++}`);
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
    const { rows } = await pool.query(sql, params);
    return rows.sort((a, b) => {
      if (a.module_type !== b.module_type) return a.module_type.localeCompare(b.module_type);
      const ka = parseItemCodeSortKey(a.item_code);
      const kb = parseItemCodeSortKey(b.item_code);
      if (ka !== kb) return ka - kb;
      return a.item_code.localeCompare(b.item_code);
    });
  },

  async getStatsByType() {
    const { rows } = await pool.query(`
      SELECT module_type,
        COUNT(*) as item_count,
        SUM(total_quantity) as total,
        SUM(in_use_quantity) as in_use,
        SUM(spare_quantity) as spare,
        SUM(storage_quantity) as storage
      FROM module_inventory
      GROUP BY module_type
      ORDER BY module_type
    `);
    return rows;
  },

  async findByCode(itemCode) {
    const { rows } = await pool.query(
      'SELECT * FROM module_inventory WHERE item_code = $1', [itemCode]
    );
    return rows[0] || null;
  },

  // [B-4d-6 유보] getUsageByCode — EUL 의존 (equipment_usage_logs status='사용중' 직접조회)

  async recalculateInUse() {
    // computing_modules에서 직접 사용량 집계 (자사+업체 모두, 활성 자산만)
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 1) specification이 설정된 모듈: 직접 매칭
      const { rows: directRows } = await client.query(`
        SELECT cm.specification as item_code, SUM(cm.count) as total_count
        FROM computing_modules cm
        JOIN assets a ON cm.asset_id = a.id
        WHERE cm.specification IS NOT NULL
          AND cm.specification != ''
          AND a.status = 'active'
        GROUP BY cm.specification
      `);

      // 2) specification이 비어있는 모듈: module_type + model로 module_inventory 매칭
      const { rows: fallbackRows } = await client.query(`
        SELECT mi.item_code, SUM(cm.count) as total_count
        FROM computing_modules cm
        JOIN assets a ON cm.asset_id = a.id
        JOIN module_inventory mi ON mi.module_type = cm.module_type AND mi.model = cm.model
        WHERE (cm.specification IS NULL OR cm.specification = '')
          AND cm.model IS NOT NULL AND cm.model != ''
          AND a.status = 'active'
        GROUP BY mi.item_code
      `);

      const usageMap = {};
      for (const row of directRows) {
        usageMap[row.item_code] = (usageMap[row.item_code] || 0) + parseInt(row.total_count);
      }
      for (const row of fallbackRows) {
        usageMap[row.item_code] = (usageMap[row.item_code] || 0) + parseInt(row.total_count);
      }

      // Reset: in_use=0, total=storage, spare=storage
      await client.query(`
        UPDATE module_inventory
        SET in_use_quantity = 0,
            total_quantity = storage_quantity,
            spare_quantity = storage_quantity
      `);

      for (const [code, count] of Object.entries(usageMap)) {
        await client.query(`
          UPDATE module_inventory
          SET in_use_quantity = $1,
              total_quantity = storage_quantity + $1,
              spare_quantity = storage_quantity,
              updated_at = CURRENT_TIMESTAMP
          WHERE item_code = $2
        `, [count, code]);
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  async findById(id) {
    const { rows } = await pool.query(
      'SELECT * FROM module_inventory WHERE id = $1', [id]
    );
    return rows[0] || null;
  },

  async updateField(id, field, value) {
    const allowed = ['manufacturer', 'model', 'capacity', 'specification', 'asset_number', 'label'];
    if (!allowed.includes(field)) throw new Error('수정할 수 없는 필드: ' + field);
    return pool.query(
      `UPDATE module_inventory SET ${field} = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [value || null, id]
    );
  },

  async getNextCodeInfo(moduleType) {
    const typeLabels = {
      cpu: 'CPU', memory: '메모리', disk: '스토리지', network: '네트워크',
      raid: 'RAID', gpu: 'GPU', cable: '케이블'
    };

    const typeName = typeLabels[moduleType];
    if (!typeName) return null;

    const items = await this.findAll(moduleType);
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

  async findStorageModules() {
    const { rows } = await pool.query(
      'SELECT * FROM module_inventory ORDER BY module_type, item_code'
    );
    return rows;
  },

  async adjustQuantity(id, quantityChange) {
    const item = await this.findById(id);
    if (!item) throw new Error('부품을 찾을 수 없습니다.');
    const newTotal = Math.max(0, item.total_quantity + quantityChange);
    const newSpare = Math.max(0, newTotal - item.in_use_quantity);
    const newStorage = Math.max(0, newTotal - item.in_use_quantity);
    await pool.query(`
      UPDATE module_inventory
      SET total_quantity = $1, spare_quantity = $2, storage_quantity = $3, updated_at = CURRENT_TIMESTAMP
      WHERE id = $4
    `, [newTotal, newSpare, newStorage, id]);
    return { before_total: item.total_quantity, after_total: newTotal, before_spare: item.spare_quantity, after_spare: newSpare };
  },

  async upsert(data) {
    return pool.query(`
      INSERT INTO module_inventory (module_type, item_code, label, manufacturer, model, capacity, specification,
        total_quantity, in_use_quantity, spare_quantity, storage_quantity, asset_number,
        owner, owner_vendor_id, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, CURRENT_TIMESTAMP)
      ON CONFLICT(item_code) DO UPDATE SET
        module_type=EXCLUDED.module_type, label=EXCLUDED.label, manufacturer=EXCLUDED.manufacturer,
        model=EXCLUDED.model, capacity=EXCLUDED.capacity, specification=EXCLUDED.specification,
        total_quantity=EXCLUDED.total_quantity, in_use_quantity=EXCLUDED.in_use_quantity,
        spare_quantity=EXCLUDED.spare_quantity, storage_quantity=EXCLUDED.storage_quantity,
        asset_number=COALESCE(EXCLUDED.asset_number, module_inventory.asset_number),
        owner=COALESCE(EXCLUDED.owner, module_inventory.owner),
        owner_vendor_id=COALESCE(EXCLUDED.owner_vendor_id, module_inventory.owner_vendor_id),
        updated_at=CURRENT_TIMESTAMP
    `, [
      data.module_type, data.item_code, data.label || null,
      data.manufacturer || null, data.model || null,
      data.capacity || null, data.specification || null,
      data.total_quantity || 0, data.in_use_quantity || 0, data.spare_quantity || 0,
      data.storage_quantity ?? data.spare_quantity ?? 0,
      data.asset_number || null,
      data.owner || 'company', data.owner_vendor_id || null
    ]);
  }
};

module.exports = ModuleInventory;
