const { getDb } = require('../config/database');
const crypto = require('crypto');

const VendorIntake = {
  generateToken() {
    return crypto.randomBytes(16).toString('hex');
  },

  findAll(status) {
    let sql = 'SELECT * FROM vendor_intake_requests';
    const params = [];
    if (status && status !== 'all') {
      sql += ' WHERE status = ?';
      params.push(status);
    }
    sql += ' ORDER BY submitted_at DESC';
    return getDb().prepare(sql).all(...params);
  },

  findById(id) {
    return getDb().prepare('SELECT * FROM vendor_intake_requests WHERE id = ?').get(id);
  },

  findByToken(token) {
    return getDb().prepare('SELECT * FROM vendor_intake_requests WHERE token = ?').get(token);
  },

  createLink() {
    const token = this.generateToken();
    const stmt = getDb().prepare(`
      INSERT INTO vendor_intake_requests (token, status, company_name, contact_name)
      VALUES (?, 'draft', '', '')
    `);
    stmt.run(token);
    return token;
  },

  submit(token, data) {
    const stmt = getDb().prepare(`
      UPDATE vendor_intake_requests SET
        status='pending', company_name=?, contact_name=?, contact_phone=?, contact_email=?,
        equipment_type=?, model_name=?, manufacturer=?, serial_number=?,
        rack_unit_size=?, quantity=?, purpose=?, expected_start=?, expected_end=?,
        power_requirement=?, network_requirement=?, notes=?,
        submitted_at=CURRENT_TIMESTAMP
      WHERE token=? AND status='draft'
    `);
    return stmt.run(
      data.company_name, data.contact_name, data.contact_phone || null, data.contact_email || null,
      data.equipment_type || 'server', data.model_name || null, data.manufacturer || null,
      data.serial_number || null, parseInt(data.rack_unit_size) || 1, parseInt(data.quantity) || 1,
      data.purpose || null, data.expected_start || null, data.expected_end || null,
      data.power_requirement || null, data.network_requirement || null, data.notes || null,
      token
    );
  },

  directSubmit(data) {
    const token = this.generateToken();
    const stmt = getDb().prepare(`
      INSERT INTO vendor_intake_requests (
        token, status, company_name, contact_name, contact_phone, contact_email,
        equipment_type, model_name, manufacturer, serial_number,
        rack_unit_size, quantity, purpose, expected_start, expected_end,
        power_requirement, network_requirement, notes
      ) VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      token,
      data.company_name, data.contact_name, data.contact_phone || null, data.contact_email || null,
      data.equipment_type || 'server', data.model_name || null, data.manufacturer || null,
      data.serial_number || null, parseInt(data.rack_unit_size) || 1, parseInt(data.quantity) || 1,
      data.purpose || null, data.expected_start || null, data.expected_end || null,
      data.power_requirement || null, data.network_requirement || null, data.notes || null
    );
    return token;
  },

  approve(id, adminNotes) {
    return getDb().prepare(`
      UPDATE vendor_intake_requests SET status='approved', admin_notes=?, reviewed_at=CURRENT_TIMESTAMP WHERE id=?
    `).run(adminNotes || null, id);
  },

  reject(id, adminNotes) {
    return getDb().prepare(`
      UPDATE vendor_intake_requests SET status='rejected', admin_notes=?, reviewed_at=CURRENT_TIMESTAMP WHERE id=?
    `).run(adminNotes || null, id);
  },

  linkAsset(id, assetId) {
    return getDb().prepare('UPDATE vendor_intake_requests SET asset_id=? WHERE id=?').run(assetId, id);
  },

  delete(id) {
    return getDb().prepare('DELETE FROM vendor_intake_requests WHERE id=?').run(id);
  },

  getStats() {
    return getDb().prepare(`
      SELECT status, COUNT(*) as count FROM vendor_intake_requests GROUP BY status
    `).all();
  }
};

module.exports = VendorIntake;
