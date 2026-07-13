const { pool } = require('../config/database');
const { formatTimestamp } = require('../utils/dateFix');

// BL-11: 감사 로그 details에 자격증명성 값이 재유입되지 않도록 마스킹.
// asset before/after 등이 ssh_password 컬럼을 포함하므로 저장 전 재귀 치환.
const SENSITIVE_KEYS = new Set(['password', 'ssh_password', 'password_enc', 'bmc_password']);
function maskSensitive(value) {
  if (Array.isArray(value)) return value.map(maskSensitive);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) {
      out[k] = SENSITIVE_KEYS.has(k)
        ? (value[k] ? '***REDACTED***' : value[k])
        : maskSensitive(value[k]);
    }
    return out;
  }
  return value;
}

const AuditLog = {
  async log(req, { action, targetType, targetId, targetLabel, details }) {
    try {
      details = maskSensitive(details);
      await pool.query(
        `INSERT INTO audit_logs (user_id, username, action, target_type, target_id, target_label, details, ip_address)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          req.session ? req.session.userId || null : null,
          req.session ? req.session.username || 'system' : 'system',
          action,
          targetType || null,
          targetId || null,
          targetLabel || null,
          typeof details === 'object' ? JSON.stringify(details) : (details || null),
          req.ip || req.connection.remoteAddress || null
        ]
      );
    } catch (err) {
      console.error('[AuditLog] Failed to log:', err.message);
    }
  },

  async findAll(filters = {}) {
    let sql = 'SELECT * FROM audit_logs WHERE 1=1';
    const params = [];
    let idx = 1;

    if (filters.date_from) {
      sql += ` AND created_at >= $${idx++}`;
      params.push(filters.date_from + ' 00:00:00');
    }
    if (filters.date_to) {
      sql += ` AND created_at <= $${idx++}`;
      params.push(filters.date_to + ' 23:59:59');
    }
    if (filters.username) {
      sql += ` AND username = $${idx++}`;
      params.push(filters.username);
    }
    if (filters.target_type) {
      sql += ` AND target_type = $${idx++}`;
      params.push(filters.target_type);
    }
    if (filters.action) {
      sql += ` AND action = $${idx++}`;
      params.push(filters.action);
    }
    if (filters.search) {
      const s = '%' + filters.search + '%';
      sql += ` AND (target_label ILIKE $${idx++} OR details ILIKE $${idx++} OR username ILIKE $${idx++})`;
      params.push(s, s, s);
    }

    sql += ' ORDER BY created_at DESC LIMIT 500';
    const { rows } = await pool.query(sql, params);
    // pg returns Date objects; views expect local-time string (UTC ISO는 9h 밀림)
    rows.forEach(r => {
      if (r.created_at instanceof Date) r.created_at = formatTimestamp(r.created_at);
    });
    return rows;
  },

  async findByTarget(targetType, targetId) {
    const { rows } = await pool.query(
      'SELECT * FROM audit_logs WHERE target_type = $1 AND target_id = $2 ORDER BY created_at DESC',
      [targetType, targetId]
    );
    return rows;
  },

  async getUsers() {
    const { rows } = await pool.query(
      'SELECT DISTINCT username FROM audit_logs WHERE username IS NOT NULL ORDER BY username'
    );
    return rows.map(r => r.username);
  },

  async getTargetTypes() {
    const { rows } = await pool.query(
      'SELECT DISTINCT target_type FROM audit_logs WHERE target_type IS NOT NULL ORDER BY target_type'
    );
    return rows.map(r => r.target_type);
  }
};

module.exports = AuditLog;
