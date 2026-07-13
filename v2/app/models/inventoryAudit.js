const { pool } = require('../config/database');
const { fixRowDates } = require('../utils/dateFix');

function fixDates(row) {
  return row ? fixRowDates(row, [], ['started_at', 'ended_at', 'checked_at', 'created_at', 'approved_at', 'reverted_at']) : row;
}

// BL-12 보정 공식(구 scripts/inventory_count_apply.js "옵션 B" 승계 — v1 CSV 워크플로우의 실전 검증 산식):
//   storage_quantity = actual,  spare_quantity = actual,
//   total_quantity   = actual + 기존 in_use_quantity,  in_use_quantity 불변.
// 자사/업체 무관 유효(운영 데이터 total=storage+in_use 불변식이 owner 양쪽 정합, spare=storage 전행 일치 — 2026-07-13 확인).

const InventoryAudit = {
  // 세션 생성 + 범위(owner/module_type) 스냅샷으로 점검 항목 시딩
  async create(auditorUserId, { scope_owner, scope_module_type }) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const owner = scope_owner || null;
      const mtype = scope_module_type || null;
      const { rows: a } = await client.query(
        `INSERT INTO inventory_audits (auditor_user_id, scope_owner, scope_module_type)
         VALUES ($1, $2, $3) RETURNING id`, [auditorUserId || null, owner, mtype]);
      const auditId = a[0].id;
      await client.query(
        `INSERT INTO inventory_audit_items
           (audit_id, item_code, module_type, system_storage_qty, system_in_use_qty)
         SELECT $1, item_code, module_type, storage_quantity, in_use_quantity
           FROM module_inventory
          WHERE item_code IS NOT NULL
            AND ($2::text IS NULL OR owner = $2)
            AND ($3::text IS NULL OR module_type = $3)
          ORDER BY module_type, item_code`, [auditId, owner, mtype]);
      await client.query('COMMIT');
      return auditId;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  async findAll() {
    const { rows } = await pool.query(
      `SELECT a.*, u.display_name AS auditor_name,
              (SELECT count(*) FROM inventory_audit_items i WHERE i.audit_id = a.id) AS item_count,
              (SELECT count(*) FROM inventory_audit_items i WHERE i.audit_id = a.id AND i.diff IS NOT NULL AND i.diff <> 0) AS diff_count
         FROM inventory_audits a
         LEFT JOIN users u ON a.auditor_user_id = u.id
        ORDER BY a.started_at DESC`);
    return rows.map(fixDates);
  },

  async findById(id) {
    const { rows } = await pool.query(
      `SELECT a.*, u.display_name AS auditor_name FROM inventory_audits a
         LEFT JOIN users u ON a.auditor_user_id = u.id WHERE a.id = $1`, [id]);
    return fixDates(rows[0]);
  },

  async getItems(auditId) {
    const { rows } = await pool.query(
      `SELECT i.*, mi.label, mi.owner
         FROM inventory_audit_items i
         LEFT JOIN module_inventory mi ON mi.item_code = i.item_code
        WHERE i.audit_id = $1 ORDER BY i.module_type, i.item_code`, [auditId]);
    return rows.map(fixDates);
  },

  // 실물 수량 임시 저장(diff 자동 계산). in_progress 세션만.
  async saveItem(auditId, itemCode, { actual, reason, ok_flag }) {
    const actualQty = (actual === '' || actual === null || actual === undefined) ? null : parseInt(actual, 10);
    return pool.query(
      `UPDATE inventory_audit_items
          SET actual_storage_qty = $1,
              diff = CASE WHEN $1::int IS NULL THEN NULL ELSE $1::int - system_storage_qty END,
              reason = $2, ok_flag = $3, checked_at = NOW()
        WHERE audit_id = $4 AND item_code = $5
          AND EXISTS (SELECT 1 FROM inventory_audits a WHERE a.id = $4 AND a.status = 'in_progress')`,
      [Number.isNaN(actualQty) ? null : actualQty, reason || null, !!ok_flag, auditId, itemCode]);
  },

  async complete(auditId) {
    return pool.query(
      `UPDATE inventory_audits SET status = 'completed', ended_at = NOW()
        WHERE id = $1 AND status = 'in_progress'`, [auditId]);
  },

  async cancel(auditId) {
    return pool.query(
      `UPDATE inventory_audits SET status = 'cancelled', ended_at = NOW()
        WHERE id = $1 AND status = 'in_progress'`, [auditId]);
  },

  // 차이 요약(적용 전 확인용): diff <> 0 이고 actual 입력된 항목
  async diffSummary(auditId) {
    const { rows } = await pool.query(
      `SELECT item_code, module_type, system_storage_qty, actual_storage_qty, diff, reason
         FROM inventory_audit_items
        WHERE audit_id = $1 AND actual_storage_qty IS NOT NULL AND diff <> 0
        ORDER BY module_type, item_code`, [auditId]);
    return rows;
  },

  // 보정 적용: 차이 항목에 옵션 B 공식 UPDATE + correction(approved) + module_inventory_logs(audit_correction).
  // 점검자=승인자 단독 운영. audit_logs 기록은 라우트에서(req 필요).
  async applyCorrections(auditId, approvedByUserId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: items } = await client.query(
        `SELECT i.item_code, i.system_storage_qty, i.system_in_use_qty, i.actual_storage_qty, i.diff, i.reason,
                mi.total_quantity, mi.spare_quantity, mi.label
           FROM inventory_audit_items i JOIN module_inventory mi ON mi.item_code = i.item_code
          WHERE i.audit_id = $1 AND i.actual_storage_qty IS NOT NULL AND i.diff <> 0
          FOR UPDATE OF mi`, [auditId]);
      let applied = 0;
      for (const it of items) {
        const actual = it.actual_storage_qty;
        const newTotal = actual + it.system_in_use_qty; // 옵션 B: total = actual + 기존 in_use
        const beforeStorage = it.system_storage_qty;
        // module_inventory 반영 (storage=actual, spare=actual, total=actual+in_use, in_use 불변)
        await client.query(
          `UPDATE module_inventory
              SET storage_quantity = $1, spare_quantity = $1, total_quantity = $2, updated_at = NOW()
            WHERE item_code = $3`, [actual, newTotal, it.item_code]);
        // 보정 이력(승인 확정)
        await client.query(
          `INSERT INTO inventory_corrections
             (audit_id, item_code, before_qty, after_qty, reason, approved_by, approved_at, status)
           VALUES ($1, $2, $3, $4, $5, $6, NOW(), 'approved')`,
          [auditId, it.item_code, beforeStorage, actual, it.reason || '재고 점검 보정', approvedByUserId || null]);
        // 부품 이력
        await client.query(
          `INSERT INTO module_inventory_logs
             (item_code, event_type, quantity_change, before_total, after_total, before_spare, after_spare, asset_label, user_id, notes)
           VALUES ($1, 'audit_correction', $2, $3, $4, $5, $6, $7, $8, $9)`,
          [it.item_code, actual - beforeStorage, it.total_quantity, newTotal, it.spare_quantity, actual,
           it.label || it.item_code, approvedByUserId || null,
           `재고 점검 보정 (점검 #${auditId}): 보관 ${beforeStorage}→${actual}`]);
        applied++;
      }
      await client.query('COMMIT');
      return applied;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  async getCorrections(auditId) {
    const { rows } = await pool.query(
      `SELECT c.*, u.display_name AS approver_name, ru.display_name AS reverter_name
         FROM inventory_corrections c
         LEFT JOIN users u ON c.approved_by = u.id
         LEFT JOIN users ru ON c.reverted_by = ru.id
        WHERE c.audit_id = $1 ORDER BY c.created_at`, [auditId]);
    return rows.map(fixDates);
  },

  // BL-12 후속: 보정 원복(undo). DELETE 없이 corrections에 원복 표기.
  // 가드: 미원복(reverted_at NULL) + 현재 storage == 보정 after_qty(적용 이후 변경분 보호)일 때만.
  // 반환: {ok:true, item_code, before, after} 또는 {ok:false, reason, current}.
  async revertCorrection(correctionId, revertedByUserId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: cr } = await client.query(
        'SELECT * FROM inventory_corrections WHERE id = $1 FOR UPDATE', [correctionId]);
      const corr = cr[0];
      if (!corr) { await client.query('ROLLBACK'); return { ok: false, reason: 'not_found' }; }
      if (corr.reverted_at) { await client.query('ROLLBACK'); return { ok: false, reason: 'already_reverted' }; }

      const { rows: mi } = await client.query(
        'SELECT storage_quantity, in_use_quantity, total_quantity, spare_quantity FROM module_inventory WHERE item_code = $1 FOR UPDATE',
        [corr.item_code]);
      if (!mi[0]) { await client.query('ROLLBACK'); return { ok: false, reason: 'module_missing' }; }
      const cur = mi[0];
      // 적용 이후 수량이 변경됐으면 원복 거부(이후 변경분 보호)
      if (cur.storage_quantity !== corr.after_qty) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'changed_since', current: cur.storage_quantity };
      }

      // 옵션 B 대칭 원복: storage=spare=before_qty, total=before + 현재 in_use, in_use 불변
      const beforeStorage = corr.before_qty;
      const newTotal = beforeStorage + cur.in_use_quantity;
      await client.query(
        `UPDATE module_inventory SET storage_quantity = $1, spare_quantity = $1, total_quantity = $2, updated_at = NOW()
          WHERE item_code = $3`, [beforeStorage, newTotal, corr.item_code]);
      await client.query(
        'UPDATE inventory_corrections SET reverted_at = NOW(), reverted_by = $1 WHERE id = $2',
        [revertedByUserId || null, correctionId]);
      await client.query(
        `INSERT INTO module_inventory_logs
           (item_code, event_type, quantity_change, before_total, after_total, before_spare, after_spare, asset_label, user_id, notes)
         VALUES ($1, 'audit_correction_revert', $2, $3, $4, $5, $6, $7, $8, $9)`,
        [corr.item_code, beforeStorage - corr.after_qty, cur.total_quantity, newTotal, cur.spare_quantity, beforeStorage,
         corr.item_code, revertedByUserId || null,
         `재고 점검 보정 원복 (점검 #${corr.audit_id}): 보관 ${corr.after_qty}→${beforeStorage}`]);
      await client.query('COMMIT');
      return { ok: true, item_code: corr.item_code, before: corr.after_qty, after: beforeStorage, audit_id: corr.audit_id };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
};

module.exports = InventoryAudit;
