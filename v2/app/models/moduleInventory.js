const { pool } = require('../config/database');

const ModuleInventory = {
  async findStorageModules() {
    const { rows } = await pool.query(
      'SELECT * FROM module_inventory ORDER BY module_type, item_code'
    );
    return rows;
  }
};

module.exports = ModuleInventory;
