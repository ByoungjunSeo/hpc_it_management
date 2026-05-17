const { getDb } = require('../config/database');

const AuditLog = {
  log(req, { action, targetType, targetId, targetLabel, details }) {
    try {
      const stmt = getDb().prepare(`
        INSERT INTO audit_logs (user_id, username, action, target_type, target_id, target_label, details, ip_address)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        req.session ? req.session.userId || null : null,
        req.session ? req.session.username || 'system' : 'system',
        action,
        targetType || null,
        targetId || null,
        targetLabel || null,
        typeof details === 'object' ? JSON.stringify(details) : (details || null),
        req.ip || req.connection.remoteAddress || null
      );
    } catch (err) {
      console.error('[AuditLog] Failed to log:', err.message);
    }
  },

  findAll(filters = {}) {
    let sql = 'SELECT * FROM audit_logs WHERE 1=1';
    const params = [];

    if (filters.date_from) {
      sql += ' AND created_at >= ?';
      params.push(filters.date_from + ' 00:00:00');
    }
    if (filters.date_to) {
      sql += ' AND created_at <= ?';
      params.push(filters.date_to + ' 23:59:59');
    }
    if (filters.username) {
      sql += ' AND username = ?';
      params.push(filters.username);
    }
    if (filters.target_type) {
      sql += ' AND target_type = ?';
      params.push(filters.target_type);
    }
    if (filters.action) {
      sql += ' AND action = ?';
      params.push(filters.action);
    }
    if (filters.search) {
      sql += ' AND (target_label LIKE ? OR details LIKE ? OR username LIKE ?)';
      const s = '%' + filters.search + '%';
      params.push(s, s, s);
    }

    sql += ' ORDER BY created_at DESC LIMIT 500';
    return getDb().prepare(sql).all(...params);
  },

  findByTarget(targetType, targetId) {
    return getDb().prepare(
      'SELECT * FROM audit_logs WHERE target_type = ? AND target_id = ? ORDER BY created_at DESC'
    ).all(targetType, targetId);
  },

  getUsers() {
    return getDb().prepare(
      'SELECT DISTINCT username FROM audit_logs WHERE username IS NOT NULL ORDER BY username'
    ).all().map(r => r.username);
  },

  getTargetTypes() {
    return getDb().prepare(
      'SELECT DISTINCT target_type FROM audit_logs WHERE target_type IS NOT NULL ORDER BY target_type'
    ).all().map(r => r.target_type);
  }
};

module.exports = AuditLog;
