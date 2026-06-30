const { pool } = require('../config/database');
const crypto = require('crypto');
const { fixRowDates } = require('../utils/dateFix');

function fixDates(row) {
  return fixRowDates(row, ['expected_start', 'expected_end'],
    ['expected_start', 'expected_end', 'submitted_at', 'reviewed_at', 'created_at', 'updated_at']);
}

const VendorIntake = {
  generateToken() {
    return crypto.randomBytes(16).toString('hex');
  },

  async findAll(status) {
    let sql = 'SELECT * FROM vendor_intake_requests';
    const params = [];
    if (status && status !== 'all') {
      sql += ' WHERE status = $1';
      params.push(status);
    }
    sql += ' ORDER BY submitted_at DESC';
    const { rows } = await pool.query(sql, params);
    return rows.map(fixDates);
  },

  async findById(id) {
    const { rows } = await pool.query('SELECT * FROM vendor_intake_requests WHERE id = $1', [id]);
    return fixDates(rows[0]);
  },

  async findByToken(token) {
    const { rows } = await pool.query('SELECT * FROM vendor_intake_requests WHERE token = $1', [token]);
    return fixDates(rows[0]);
  },

  async createLink() {
    const token = this.generateToken();
    await pool.query(
      `INSERT INTO vendor_intake_requests (token, status, company_name, contact_name)
       VALUES ($1, 'draft', '', '')`,
      [token]
    );
    return token;
  },

  async submit(token, data) {
    const result = await pool.query(
      `UPDATE vendor_intake_requests SET
        status='pending', company_name=$1, contact_name=$2, contact_phone=$3, contact_email=$4,
        equipment_type=$5, model_name=$6, manufacturer=$7, serial_number=$8,
        rack_unit_size=$9, quantity=$10, purpose=$11, expected_start=$12, expected_end=$13,
        power_requirement=$14, network_requirement=$15, notes=$16,
        submitted_at=CURRENT_TIMESTAMP
      WHERE token=$17 AND status='draft'`,
      [
        data.company_name, data.contact_name, data.contact_phone || null, data.contact_email || null,
        data.equipment_type || 'server', data.model_name || null, data.manufacturer || null,
        data.serial_number || null, parseInt(data.rack_unit_size) || 1, parseInt(data.quantity) || 1,
        data.purpose || null, data.expected_start || null, data.expected_end || null,
        data.power_requirement || null, data.network_requirement || null, data.notes || null,
        token
      ]
    );
    return result;
  },

  async directSubmit(data) {
    const token = this.generateToken();
    await pool.query(
      `INSERT INTO vendor_intake_requests (
        token, status, company_name, contact_name, contact_phone, contact_email,
        equipment_type, model_name, manufacturer, serial_number,
        rack_unit_size, quantity, purpose, expected_start, expected_end,
        power_requirement, network_requirement, notes
      ) VALUES ($1, 'pending', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
      [
        token,
        data.company_name, data.contact_name, data.contact_phone || null, data.contact_email || null,
        data.equipment_type || 'server', data.model_name || null, data.manufacturer || null,
        data.serial_number || null, parseInt(data.rack_unit_size) || 1, parseInt(data.quantity) || 1,
        data.purpose || null, data.expected_start || null, data.expected_end || null,
        data.power_requirement || null, data.network_requirement || null, data.notes || null
      ]
    );
    return token;
  },

  async approve(id, adminNotes) {
    return pool.query(
      `UPDATE vendor_intake_requests SET status='approved', admin_notes=$1, reviewed_at=CURRENT_TIMESTAMP WHERE id=$2`,
      [adminNotes || null, id]
    );
  },

  async reject(id, adminNotes) {
    return pool.query(
      `UPDATE vendor_intake_requests SET status='rejected', admin_notes=$1, reviewed_at=CURRENT_TIMESTAMP WHERE id=$2`,
      [adminNotes || null, id]
    );
  },

  async linkAsset(id, assetId) {
    return pool.query('UPDATE vendor_intake_requests SET asset_id=$1 WHERE id=$2', [assetId, id]);
  },

  async delete(id) {
    return pool.query('DELETE FROM vendor_intake_requests WHERE id=$1', [id]);
  },

  async getStats() {
    const { rows } = await pool.query(
      'SELECT status, COUNT(*) as count FROM vendor_intake_requests GROUP BY status'
    );
    return rows;
  }
};

module.exports = VendorIntake;
