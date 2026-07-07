const { pool } = require('../config/database');
const fs = require('fs');
const path = require('path');

const { formatTimestamp } = require('../utils/dateFix');

function fixDates(row) {
  if (!row) return row;
  if (row.uploaded_at instanceof Date) row.uploaded_at = formatTimestamp(row.uploaded_at);
  return row;
}

const Photo = {
  async findByEntity(entityType, entityId) {
    const { rows } = await pool.query(
      'SELECT * FROM photos WHERE entity_type = $1 AND entity_id = $2 ORDER BY uploaded_at DESC',
      [entityType, entityId]
    );
    rows.forEach(fixDates);
    return rows;
  },

  async findByAssetWithUsageLogs(assetId, managementNumber) {
    if (!managementNumber) {
      return this.findByEntity('asset', assetId);
    }
    const { rows } = await pool.query(`
      SELECT p.* FROM photos p
      WHERE (p.entity_type = 'asset' AND p.entity_id = $1)
         OR (p.entity_type = 'equipment_usage' AND p.entity_id IN (
              SELECT id FROM equipment_usage_logs WHERE management_number = $2
            ))
      ORDER BY p.uploaded_at DESC
    `, [assetId, managementNumber]);
    rows.forEach(fixDates);
    return rows;
  },

  async findById(id) {
    const { rows } = await pool.query('SELECT * FROM photos WHERE id = $1', [id]);
    return fixDates(rows[0]) || null;
  },

  async create(data) {
    const { rows } = await pool.query(
      `INSERT INTO photos (entity_type, entity_id, file_path, original_name, description, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [data.entity_type, data.entity_id, data.file_path, data.original_name || null,
       data.description || null, data.uploaded_by || null]
    );
    return rows[0].id;
  },

  async bulkCreate(entityType, entityId, files, uploadedBy) {
    const client = await pool.connect();
    const ids = [];
    try {
      await client.query('BEGIN');
      for (const file of files) {
        const subDirMap = { module: 'modules', lending: 'lendings' };
        const subDir = subDirMap[entityType] || 'assets';
        const relativePath = '/uploads/photos/' + subDir + '/' + file.filename;
        const { rows } = await client.query(
          `INSERT INTO photos (entity_type, entity_id, file_path, original_name, uploaded_by)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [entityType, entityId, relativePath, file.originalname, uploadedBy || null]
        );
        ids.push(rows[0].id);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    return ids;
  },

  async delete(id) {
    const photo = await this.findById(id);
    if (!photo) return false;

    // Delete from DB first
    await pool.query('DELETE FROM photos WHERE id = $1', [id]);

    // Then delete file from filesystem
    const filePath = path.join(__dirname, '..', 'public', photo.file_path);
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (e) {
      console.error('[Photo] File delete error:', e.message);
    }

    return true;
  },

  async deleteByEntity(entityType, entityId) {
    const photos = await this.findByEntity(entityType, entityId);
    await pool.query(
      'DELETE FROM photos WHERE entity_type = $1 AND entity_id = $2',
      [entityType, entityId]
    );
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
    return photos.length;
  }
};

module.exports = Photo;
