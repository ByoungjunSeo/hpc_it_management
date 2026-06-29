const { pool } = require('../config/database');

// v2 event_type → Korean label mapping (dashboard.ejs expects Korean keys)
const EVENT_TYPE_LABEL = {
  incoming: '입고',
  in_use: '사용중',
  returned: '반납완료'
};

const EquipmentUsageLog = {
  async getRecent(limit = 10) {
    const { rows } = await pool.query(
      `SELECT *,
              event_date as usage_date
       FROM equipment_usage_logs
       ORDER BY COALESCE(event_date, created_at) DESC, id DESC
       LIMIT $1`, [limit]
    );
    // Map event_type to Korean 'status' for view compatibility
    return rows.map(r => ({
      ...r,
      status: EVENT_TYPE_LABEL[r.event_type] || r.event_type
    }));
  },

  async countByStatus() {
    const { rows } = await pool.query(
      'SELECT event_type, COUNT(*) as count FROM equipment_usage_logs GROUP BY event_type'
    );
    const result = { total: 0 };
    rows.forEach(r => {
      const label = EVENT_TYPE_LABEL[r.event_type] || r.event_type;
      result[label] = parseInt(r.count);
      result.total += parseInt(r.count);
    });
    return result;
  },

  async getMonthlyTrend() {
    const { rows } = await pool.query(
      `SELECT TO_CHAR(COALESCE(event_date, created_at), 'YYYY-MM') as month,
              event_type, COUNT(*) as count
       FROM equipment_usage_logs
       WHERE COALESCE(event_date, created_at) >= CURRENT_DATE - INTERVAL '6 months'
       GROUP BY month, event_type
       ORDER BY month`
    );
    // Map event_type to Korean 'status' for view compatibility
    return rows.map(r => ({
      ...r,
      status: EVENT_TYPE_LABEL[r.event_type] || r.event_type
    }));
  }
};

module.exports = EquipmentUsageLog;
