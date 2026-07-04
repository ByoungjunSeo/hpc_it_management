const { pool } = require('../config/database');

const ComputingModule = {
  async findAll(filters = {}) {
    let sql = `
      SELECT cm.*, a.model_name as asset_model, a.asset_number, a.ip_address,
        v.vendor_name as owner_vendor_name
      FROM computing_modules cm
      JOIN assets a ON cm.asset_id = a.id
      LEFT JOIN vendor_info v ON cm.owner_vendor_id = v.id
      WHERE 1=1
    `;
    const params = [];
    let idx = 1;

    if (filters.module_type) {
      sql += ` AND cm.module_type = $${idx++}`;
      params.push(filters.module_type);
    }
    if (filters.asset_id) {
      sql += ` AND cm.asset_id = $${idx++}`;
      params.push(filters.asset_id);
    }
    if (filters.owner) {
      if (filters.owner === 'company') {
        sql += " AND (cm.owner IS NULL OR cm.owner = 'company')";
      } else if (filters.owner === 'vendor') {
        sql += " AND cm.owner = 'vendor'";
      }
    }
    if (filters.search) {
      sql += ` AND (cm.model ILIKE $${idx} OR cm.manufacturer ILIKE $${idx} OR a.model_name ILIKE $${idx}
        OR cm.specification ILIKE $${idx} OR a.management_number ILIKE $${idx}
        OR EXISTS (
          SELECT 1 FROM module_inventory mi
          WHERE mi.item_code ILIKE $${idx}
          AND mi.module_type = cm.module_type
          AND mi.model = cm.model
        ))`;
      const s = '%' + filters.search + '%';
      params.push(s);
      idx++;
    }

    sql += ' ORDER BY cm.asset_id, cm.module_type';
    const { rows } = await pool.query(sql, params);
    return rows;
  },

  async findById(id) {
    const { rows } = await pool.query(`
      SELECT cm.*, a.model_name as asset_model, a.asset_number,
        v.vendor_name as owner_vendor_name
      FROM computing_modules cm
      JOIN assets a ON cm.asset_id = a.id
      LEFT JOIN vendor_info v ON cm.owner_vendor_id = v.id
      WHERE cm.id = $1
    `, [id]);
    return rows[0] || null;
  },

  async findByAsset(assetId) {
    const { rows } = await pool.query(
      `SELECT cm.*, v.vendor_name as owner_vendor_name
       FROM computing_modules cm
       LEFT JOIN vendor_info v ON cm.owner_vendor_id = v.id
       WHERE cm.asset_id = $1 ORDER BY cm.module_type, cm.id`, [assetId]
    );
    return rows;
  },

  async create(data) {
    const { rows } = await pool.query(`
      INSERT INTO computing_modules (asset_id, module_type, model, manufacturer, capacity, count, specification, slot_info, notes, owner, owner_vendor_id, is_onboard)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING id
    `, [
      data.asset_id, data.module_type, data.model, data.manufacturer,
      data.capacity, data.count || 1, data.specification, data.slot_info, data.notes,
      data.owner || 'company', data.owner_vendor_id || null, data.is_onboard || 0
    ]);
    return rows[0].id;
  },

  async update(id, data) {
    return pool.query(`
      UPDATE computing_modules SET asset_id=$1, module_type=$2, model=$3, manufacturer=$4, capacity=$5,
        count=$6, specification=$7, slot_info=$8, notes=$9, owner=$10, owner_vendor_id=$11, is_onboard=$12, updated_at=CURRENT_TIMESTAMP
      WHERE id=$13
    `, [
      data.asset_id, data.module_type, data.model, data.manufacturer,
      data.capacity, data.count || 1, data.specification, data.slot_info, data.notes,
      data.owner || 'company', data.owner_vendor_id || null, data.is_onboard || 0, id
    ]);
  },

  async delete(id) {
    return pool.query('DELETE FROM computing_modules WHERE id = $1', [id]);
  },

  async deleteByAsset(assetId) {
    return pool.query('DELETE FROM computing_modules WHERE asset_id = $1', [assetId]);
  },

  async bulkCreate(assetId, modules) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const m of modules) {
        await client.query(`
          INSERT INTO computing_modules (asset_id, module_type, model, manufacturer, capacity, count, specification, slot_info, notes, owner, owner_vendor_id, is_onboard)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        `, [
          assetId, m.module_type, m.model, m.manufacturer,
          m.capacity, m.count || 1, m.specification, m.slot_info, m.notes,
          m.owner || 'company', m.owner_vendor_id || null, m.is_onboard || 0
        ]);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
};

module.exports = ComputingModule;
