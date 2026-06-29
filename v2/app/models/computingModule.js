const { pool } = require('../config/database');

const ComputingModule = {
  async findByAsset(assetId) {
    const { rows } = await pool.query(
      `SELECT cm.*, v.vendor_name as owner_vendor_name
       FROM computing_modules cm
       LEFT JOIN vendor_info v ON cm.owner_vendor_id = v.id
       WHERE cm.asset_id = $1 ORDER BY cm.module_type, cm.id`, [assetId]
    );
    return rows;
  }
};

module.exports = ComputingModule;
