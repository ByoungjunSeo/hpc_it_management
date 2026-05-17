const { getDb } = require('../config/database');
const fs = require('fs');
const path = require('path');

const Photo = {
  findByEntity(entityType, entityId) {
    const db = getDb();
    return db.prepare(
      'SELECT * FROM photos WHERE entity_type = ? AND entity_id = ? ORDER BY uploaded_at DESC'
    ).all(entityType, entityId);
  },

  findByAssetWithUsageLogs(assetId, managementNumber) {
    const db = getDb();
    if (!managementNumber) {
      return this.findByEntity('asset', assetId);
    }
    // asset 사진 + 해당 관리번호의 equipment_usage_log 사진을 합쳐서 반환
    return db.prepare(`
      SELECT p.* FROM photos p
      WHERE (p.entity_type = 'asset' AND p.entity_id = ?)
         OR (p.entity_type = 'equipment_usage' AND p.entity_id IN (
              SELECT id FROM equipment_usage_logs WHERE management_number = ?
            ))
      ORDER BY p.uploaded_at DESC
    `).all(assetId, managementNumber);
  },

  findById(id) {
    const db = getDb();
    return db.prepare('SELECT * FROM photos WHERE id = ?').get(id);
  },

  create(data) {
    const db = getDb();
    const result = db.prepare(
      'INSERT INTO photos (entity_type, entity_id, file_path, original_name, description, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(
      data.entity_type,
      data.entity_id,
      data.file_path,
      data.original_name || null,
      data.description || null,
      data.uploaded_by || null
    );
    return result.lastInsertRowid;
  },

  bulkCreate(entityType, entityId, files, uploadedBy) {
    const db = getDb();
    const stmt = db.prepare(
      'INSERT INTO photos (entity_type, entity_id, file_path, original_name, uploaded_by) VALUES (?, ?, ?, ?, ?)'
    );
    const ids = [];
    const tx = db.transaction(() => {
      for (const file of files) {
        const subDirMap = { module: 'modules', lending: 'lendings' };
        const subDir = subDirMap[entityType] || 'assets';
        const relativePath = '/uploads/photos/' + subDir + '/' + file.filename;
        const result = stmt.run(entityType, entityId, relativePath, file.originalname, uploadedBy || null);
        ids.push(result.lastInsertRowid);
      }
    });
    tx();
    return ids;
  },

  delete(id) {
    const db = getDb();
    const photo = this.findById(id);
    if (!photo) return false;

    // Delete file from filesystem
    const filePath = path.join(__dirname, '..', 'public', photo.file_path);
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (e) {
      console.error('[Photo] File delete error:', e.message);
    }

    db.prepare('DELETE FROM photos WHERE id = ?').run(id);
    return true;
  },

  deleteByEntity(entityType, entityId) {
    const photos = this.findByEntity(entityType, entityId);
    for (const photo of photos) {
      const filePath = path.join(__dirname, '..', 'public', photo.file_path);
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      } catch (e) {
        console.error('[Photo] File delete error:', e.message);
      }
    }
    const db = getDb();
    db.prepare('DELETE FROM photos WHERE entity_type = ? AND entity_id = ?').run(entityType, entityId);
    return photos.length;
  }
};

module.exports = Photo;
