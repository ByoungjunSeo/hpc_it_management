const { pool } = require('../config/database');
const { fixRowDates } = require('../utils/dateFix');

function fixDates(row) {
  return fixRowDates(row, ['contract_start', 'contract_end'],
    ['contract_start', 'contract_end', 'created_at', 'updated_at']);
}

const Vendor = {
  async findAll() {
    const { rows } = await pool.query(
      'SELECT * FROM vendor_info ORDER BY vendor_name'
    );
    rows.forEach(fixDates);
    return rows;
  },

  async findById(id) {
    const { rows } = await pool.query('SELECT * FROM vendor_info WHERE id = $1', [id]);
    return fixDates(rows[0]) || null;
  },

  async create(data) {
    const { rows } = await pool.query(
      `INSERT INTO vendor_info (vendor_name, contact_person, contact_email, contact_phone, contract_start, contract_end, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [data.vendor_name, data.contact_person || null, data.contact_email || null,
       data.contact_phone || null, data.contract_start || null, data.contract_end || null,
       data.notes || null]
    );
    return rows[0].id;
  },

  async update(id, data) {
    return pool.query(
      `UPDATE vendor_info SET vendor_name=$1, contact_person=$2, contact_email=$3, contact_phone=$4,
       contract_start=$5, contract_end=$6, notes=$7, updated_at=NOW()
       WHERE id=$8`,
      [data.vendor_name, data.contact_person || null, data.contact_email || null,
       data.contact_phone || null, data.contract_start || null, data.contract_end || null,
       data.notes || null, id]
    );
  },

  async delete(id) {
    return pool.query('DELETE FROM vendor_info WHERE id = $1', [id]);
  }
};

module.exports = Vendor;
