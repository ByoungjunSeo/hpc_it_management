const { getDb } = require('../config/database');

const Vendor = {
  findAll() {
    return getDb().prepare('SELECT * FROM vendor_info ORDER BY vendor_name').all();
  },

  findById(id) {
    return getDb().prepare('SELECT * FROM vendor_info WHERE id = ?').get(id);
  },

  create(data) {
    const stmt = getDb().prepare(`
      INSERT INTO vendor_info (vendor_name, contact_person, contact_email, contact_phone, contract_number, contract_start, contract_end, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      data.vendor_name, data.contact_person, data.contact_email,
      data.contact_phone, data.contract_number, data.contract_start,
      data.contract_end, data.notes
    );
    return result.lastInsertRowid;
  },

  update(id, data) {
    const stmt = getDb().prepare(`
      UPDATE vendor_info SET vendor_name=?, contact_person=?, contact_email=?, contact_phone=?,
        contract_number=?, contract_start=?, contract_end=?, notes=?, updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `);
    return stmt.run(
      data.vendor_name, data.contact_person, data.contact_email,
      data.contact_phone, data.contract_number, data.contract_start,
      data.contract_end, data.notes, id
    );
  },

  delete(id) {
    return getDb().prepare('DELETE FROM vendor_info WHERE id = ?').run(id);
  }
};

module.exports = Vendor;
