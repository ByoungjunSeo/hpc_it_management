const { pool } = require('../config/database');
const { formatTimestamp } = require('../utils/dateFix');

// pg returns timestamp as Date object; v1 views expect local-time string (UTC ISO는 9h 밀림)
function fixTimestamps(row) {
  if (row && row.created_at instanceof Date) {
    row.created_at = formatTimestamp(row.created_at);
  }
  return row;
}

const ModuleInventoryLog = {
  async create(data) {
    const { rows } = await pool.query(`
      INSERT INTO module_inventory_logs
        (item_code, event_type, quantity_change,
         before_total, after_total, before_spare, after_spare,
         asset_id, asset_label,
         from_asset_id, from_asset_label, to_asset_id, to_asset_label,
         asset_number, user_id, username, notes)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
      RETURNING id
    `, [
      data.item_code,
      data.event_type,
      data.quantity_change || 0,
      data.before_total ?? null,
      data.after_total ?? null,
      data.before_spare ?? null,
      data.after_spare ?? null,
      data.asset_id || null,
      data.asset_label || null,
      data.from_asset_id || null,
      data.from_asset_label || null,
      data.to_asset_id || null,
      data.to_asset_label || null,
      data.asset_number || null,
      data.user_id || null,
      data.username || null,
      data.notes || null
    ]);
    return rows[0].id;
  },

  async findByItemCode(code, limit) {
    const l = limit || 100;
    const { rows } = await pool.query(`
      SELECT * FROM module_inventory_logs
      WHERE item_code = $1
      ORDER BY created_at DESC
      LIMIT $2
    `, [code, l]);
    return rows.map(fixTimestamps);
  },

  async findByAsset(assetId) {
    const { rows } = await pool.query(`
      SELECT * FROM module_inventory_logs
      WHERE asset_id = $1 OR from_asset_id = $1 OR to_asset_id = $1
      ORDER BY created_at DESC
    `, [assetId]);
    return rows.map(fixTimestamps);
  },

  async findAll(filters = {}, limit = 200) {
    let sql = 'SELECT * FROM module_inventory_logs WHERE 1=1';
    const params = [];
    let idx = 1;

    if (filters.event_type) {
      sql += ` AND event_type = $${idx++}`;
      params.push(filters.event_type);
    }
    if (filters.item_code) {
      sql += ` AND item_code = $${idx++}`;
      params.push(filters.item_code);
    }
    if (filters.date_from) {
      sql += ` AND created_at >= $${idx++}`;
      params.push(filters.date_from);
    }
    if (filters.date_to) {
      sql += ` AND created_at <= ($${idx++})::date + interval '1 day' - interval '1 second'`;
      params.push(filters.date_to);
    }
    if (filters.search) {
      sql += ` AND (item_code ILIKE $${idx} OR asset_label ILIKE $${idx} OR notes ILIKE $${idx} OR username ILIKE $${idx})`;
      params.push('%' + filters.search + '%');
      idx++;
    }

    sql += ` ORDER BY created_at DESC LIMIT $${idx++}`;
    params.push(limit);

    const { rows } = await pool.query(sql, params);
    return rows.map(fixTimestamps);
  },

  async countByEventType() {
    const { rows } = await pool.query(
      'SELECT event_type, COUNT(*) as count FROM module_inventory_logs GROUP BY event_type'
    );
    const result = { total: 0 };
    rows.forEach(r => {
      result[r.event_type] = parseInt(r.count);
      result.total += parseInt(r.count);
    });
    return result;
  },

  async getItemCodes() {
    const { rows } = await pool.query(`
      SELECT DISTINCT item_code FROM module_inventory_logs
      WHERE item_code IS NOT NULL AND item_code != ''
      ORDER BY item_code
    `);
    return rows.map(r => r.item_code);
  }
};

module.exports = ModuleInventoryLog;
