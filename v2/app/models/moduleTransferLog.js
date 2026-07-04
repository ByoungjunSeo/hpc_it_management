const { pool } = require('../config/database');
const { fixRowDates } = require('../utils/dateFix');

const DATE_ONLY_COLS = ['transfer_date'];
const ALL_DATE_COLS = ['transfer_date', 'created_at'];

function fixDates(row) {
  return fixRowDates(row, DATE_ONLY_COLS, ALL_DATE_COLS);
}

const ModuleTransferLog = {
  async create(data) {
    const { rows } = await pool.query(`
      INSERT INTO module_transfer_logs
        (transfer_date, module_type, model, capacity, count, owner, owner_vendor_id,
         from_asset_id, from_asset_label, to_asset_id, to_asset_label,
         reason, user_id, username, notes)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      RETURNING id
    `, [
      data.transfer_date || null,
      data.module_type,
      data.model || null,
      data.capacity || null,
      data.count || 1,
      data.owner || 'company',
      data.owner_vendor_id || null,
      data.from_asset_id || null,
      data.from_asset_label || null,
      data.to_asset_id || null,
      data.to_asset_label || null,
      data.reason || null,
      data.user_id || null,
      data.username || null,
      data.notes || null
    ]);
    return rows[0].id;
  },

  async bulkCreate(logs) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const d of logs) {
        await client.query(`
          INSERT INTO module_transfer_logs
            (transfer_date, module_type, model, capacity, count, owner, owner_vendor_id,
             from_asset_id, from_asset_label, to_asset_id, to_asset_label,
             reason, user_id, username, notes)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        `, [
          d.transfer_date || null,
          d.module_type,
          d.model || null,
          d.capacity || null,
          d.count || 1,
          d.owner || 'company',
          d.owner_vendor_id || null,
          d.from_asset_id || null,
          d.from_asset_label || null,
          d.to_asset_id || null,
          d.to_asset_label || null,
          d.reason || null,
          d.user_id || null,
          d.username || null,
          d.notes || null
        ]);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  async findByAsset(assetId) {
    const { rows } = await pool.query(`
      SELECT mtl.*, v.vendor_name as owner_vendor_name
      FROM module_transfer_logs mtl
      LEFT JOIN vendor_info v ON mtl.owner_vendor_id = v.id
      WHERE mtl.from_asset_id = $1 OR mtl.to_asset_id = $1
      ORDER BY mtl.created_at DESC
    `, [assetId]);
    return rows.map(fixDates);
  },

  async findAll(filters = {}) {
    let sql = `
      SELECT mtl.*, v.vendor_name as owner_vendor_name
      FROM module_transfer_logs mtl
      LEFT JOIN vendor_info v ON mtl.owner_vendor_id = v.id
      WHERE 1=1
    `;
    const params = [];
    let idx = 1;

    if (filters.asset_id) {
      sql += ` AND (mtl.from_asset_id = $${idx} OR mtl.to_asset_id = $${idx})`;
      params.push(filters.asset_id);
      idx++;
    }
    if (filters.from_date) {
      sql += ` AND mtl.transfer_date >= $${idx++}`;
      params.push(filters.from_date);
    }
    if (filters.to_date) {
      sql += ` AND mtl.transfer_date <= $${idx++}`;
      params.push(filters.to_date);
    }
    if (filters.module_type) {
      sql += ` AND mtl.module_type = $${idx++}`;
      params.push(filters.module_type);
    }

    sql += ' ORDER BY mtl.created_at DESC';

    if (filters.limit) {
      sql += ` LIMIT $${idx++}`;
      params.push(filters.limit);
    }

    const { rows } = await pool.query(sql, params);
    return rows.map(fixDates);
  }
};

module.exports = ModuleTransferLog;
