const { pool } = require('../config/database');
const { fixRowDates } = require('../utils/dateFix');
const appConfig = require('../config/app');

// BL-13: 재고 연동 대상은 부품 유형만 — 장비 유형은 asset_id로 개체 연결
const MODULE_TYPE_VALUES = appConfig.moduleTypes.map(t => t.value);

function fixDates(row) {
  return fixRowDates(row, ['loan_date', 'due_date', 'return_date'],
    ['loan_date', 'due_date', 'return_date', 'created_at', 'last_returned_at']);
}

function qtyOf(item) {
  return parseInt(item.quantity) || 1;
}

// counterparty가 vendor_name과 정확 일치하면 FK 자동 연결 (자유 텍스트 본선)
async function resolveVendorId(client, counterparty) {
  if (!counterparty) return null;
  const { rows } = await client.query(
    'SELECT id FROM vendor_info WHERE vendor_name = $1', [counterparty.trim()]
  );
  return rows.length > 0 ? rows[0].id : null;
}

function isInventoryCandidate(direction, item) {
  // 대출(outbound) 부품 품목만 재고 연동. 차입(inbound)은 owner='vendor' 체계와
  // 이중 기록 방지를 위해 무연동(BL-13 확정 결정 4).
  return direction === 'outbound' && !!item.item_code
    && MODULE_TYPE_VALUES.includes(item.item_type);
}

async function insertLendingInvLog(client, data, actor) {
  await client.query(`
    INSERT INTO module_inventory_logs
      (item_code, event_type, quantity_change, before_total, after_total,
       before_spare, after_spare, from_asset_label, to_asset_label,
       user_id, username, notes)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
  `, [
    data.item_code, data.event_type, data.quantity_change,
    data.before_total, data.after_total, data.before_spare, data.after_spare,
    data.from_asset_label || null, data.to_asset_label || null,
    actor ? actor.userId || null : null,
    actor ? actor.username || null : null,
    data.notes || null
  ]);
}

// 대출 등록 차감 — storage에서 대여 수량만큼.
// 수량 불변식(total=storage+in_use, spare=storage — recalculateInUse가 재유도)과
// 정합되도록 storage/spare/total 3필드 동시 감소. 재고 행이 없으면 무연동(false).
async function deductForLending(client, item, qty, ctx) {
  const { rows } = await client.query(
    'SELECT * FROM module_inventory WHERE item_code = $1 FOR UPDATE', [item.item_code]
  );
  const inv = rows[0];
  if (!inv) return false;
  const storage = inv.storage_quantity || 0;
  if (storage < qty) {
    throw new Error(`재고 부족: ${item.item_code} 보관 ${storage}개 < 대여 ${qty}개 — 등록이 거부되었습니다.`);
  }
  await client.query(`
    UPDATE module_inventory
    SET storage_quantity = storage_quantity - $1,
        spare_quantity = spare_quantity - $1,
        total_quantity = total_quantity - $1,
        updated_at = CURRENT_TIMESTAMP
    WHERE item_code = $2
  `, [qty, item.item_code]);
  await insertLendingInvLog(client, {
    item_code: item.item_code,
    event_type: 'lending_out',
    quantity_change: -qty,
    before_total: inv.total_quantity, after_total: inv.total_quantity - qty,
    before_spare: inv.spare_quantity, after_spare: inv.spare_quantity - qty,
    to_asset_label: `대여(${ctx.counterparty})`,
    notes: ctx.notes || null
  }, ctx.actor);
  return true;
}

// 반납/수정/삭제 복귀 — inventory_linked=true 품목만 호출된다
async function restoreForLending(client, item, qty, ctx) {
  const { rows } = await client.query(
    'SELECT * FROM module_inventory WHERE item_code = $1 FOR UPDATE', [item.item_code]
  );
  const inv = rows[0];
  if (!inv) {
    throw new Error(`재고 복귀 실패: 부품 ${item.item_code}의 재고 항목이 없습니다.`);
  }
  await client.query(`
    UPDATE module_inventory
    SET storage_quantity = storage_quantity + $1,
        spare_quantity = spare_quantity + $1,
        total_quantity = total_quantity + $1,
        updated_at = CURRENT_TIMESTAMP
    WHERE item_code = $2
  `, [qty, item.item_code]);
  await insertLendingInvLog(client, {
    item_code: item.item_code,
    event_type: 'lending_return',
    quantity_change: qty,
    before_total: inv.total_quantity, after_total: inv.total_quantity + qty,
    before_spare: inv.spare_quantity, after_spare: inv.spare_quantity + qty,
    from_asset_label: `대여반납(${ctx.counterparty})`,
    notes: ctx.notes || null
  }, ctx.actor);
}

async function insertItem(client, lendingId, item, linked) {
  await client.query(`
    INSERT INTO lending_items
      (lending_id, item_type, item_code, quantity, description, asset_id, inventory_linked)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
  `, [lendingId, item.item_type, item.item_code || null, qtyOf(item),
      item.description || null, item.asset_id || null, linked]);
}

// 장비 품목 랙 해제 (확정 결정 3): 실장 중이면 rack 연결 해제.
// 반납 시 자동 재실장은 없음 — 화면에서 안내. 해제된 자산 라벨을 모아 라우트가 감사로그 기록.
async function releaseRackIfRequested(client, item, releasedAssets) {
  if (!item.release_rack || !item.asset_id) return;
  const { rows } = await client.query(
    'SELECT id, management_number, model_name, rack_id FROM assets WHERE id = $1 FOR UPDATE',
    [item.asset_id]
  );
  const asset = rows[0];
  if (!asset || !asset.rack_id) return;
  await client.query(
    'UPDATE assets SET rack_id = NULL, rack_unit_start = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = $1',
    [asset.id]
  );
  releasedAssets.push({
    id: asset.id,
    label: asset.management_number || asset.model_name || `ID:${asset.id}`
  });
}

// 전 품목 완납 여부 → lendings 상태 확정. 반납 처리 경로들이 공유.
async function finalizeIfAllReturned(client, lendingId) {
  const { rows } = await client.query(
    `SELECT COUNT(*)::int AS remaining FROM lending_items
     WHERE lending_id = $1 AND returned_quantity < COALESCE(quantity, 1)`,
    [lendingId]
  );
  if (rows[0].remaining === 0) {
    await client.query(
      `UPDATE lendings SET status = 'returned', return_date = CURRENT_DATE WHERE id = $1`,
      [lendingId]
    );
    return true;
  }
  return false;
}

const Lending = {
  async findAll(filters = {}) {
    let sql = `
      SELECT l.*,
        STRING_AGG(li.item_type || ':' || COALESCE(li.item_code,'') || ' x' || li.quantity, ', ') as items_summary,
        (l.status = 'active' AND l.due_date IS NOT NULL AND l.due_date < CURRENT_DATE) as overdue
      FROM lendings l
      LEFT JOIN lending_items li ON li.lending_id = l.id
      WHERE 1=1
    `;
    const params = [];
    let idx = 1;

    if (filters.direction) {
      sql += ' AND l.direction = $' + idx++;
      params.push(filters.direction);
    }
    if (filters.status) {
      sql += ' AND l.status = $' + idx++;
      params.push(filters.status);
    }
    if (filters.search) {
      sql += ' AND (l.counterparty ILIKE $' + idx + ' OR l.notes ILIKE $' + (idx + 1) + ')';
      const s = '%' + filters.search + '%';
      params.push(s, s);
      idx += 2;
    }

    sql += ' GROUP BY l.id ORDER BY l.created_at DESC';
    const { rows } = await pool.query(sql, params);
    rows.forEach(fixDates);
    return rows;
  },

  async findById(id) {
    const { rows } = await pool.query('SELECT * FROM lendings WHERE id = $1', [id]);
    const lending = fixDates(rows[0]);
    if (!lending) return null;
    // 품목에 자산·재고 표시 정보 보강 (수정 폼·반납 화면용)
    const items = await pool.query(`
      SELECT li.*,
        a.management_number AS asset_management_number,
        a.model_name AS asset_model_name,
        a.rack_id AS asset_rack_id,
        mi.storage_quantity AS inv_storage_quantity,
        (mi.id IS NOT NULL) AS inv_exists
      FROM lending_items li
      LEFT JOIN assets a ON a.id = li.asset_id
      LEFT JOIN module_inventory mi ON mi.item_code = li.item_code
      WHERE li.lending_id = $1 ORDER BY li.id
    `, [id]);
    items.rows.forEach(r => fixRowDates(r, [], ['last_returned_at']));
    lending.items = items.rows;
    return lending;
  },

  // BL-13: 자산 상세 배지용 — 해당 자산이 잔여 수량으로 걸린 active 대여 건
  async findActiveByAsset(assetId) {
    const { rows } = await pool.query(`
      SELECT l.id, l.direction, l.counterparty, l.loan_date, l.due_date,
        (l.due_date IS NOT NULL AND l.due_date < CURRENT_DATE) as overdue
      FROM lending_items li
      JOIN lendings l ON l.id = li.lending_id
      WHERE li.asset_id = $1 AND l.status = 'active'
        AND li.returned_quantity < COALESCE(li.quantity, 1)
      ORDER BY l.created_at DESC
    `, [assetId]);
    rows.forEach(fixDates);
    return rows;
  },

  // 등록 — outbound 부품 품목은 재고 차감(부족 시 전체 롤백·거부),
  // release_rack 요청 품목은 랙 해제. 반환: { id, releasedAssets }
  async create(data, items, actor) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const vendorId = await resolveVendorId(client, data.counterparty);
      const { rows } = await client.query(
        `INSERT INTO lendings (direction, counterparty, counterparty_vendor_id, loan_date, due_date, status, notes)
         VALUES ($1, $2, $3, $4, $5, 'active', $6) RETURNING id`,
        [data.direction, data.counterparty, vendorId,
         data.loan_date || null, data.due_date || null, data.notes || null]
      );
      const lendingId = rows[0].id;
      const releasedAssets = [];
      const ctx = { counterparty: data.counterparty, actor, notes: `[대여장부 #${lendingId}]` };

      for (const item of items || []) {
        if (!item.item_type) continue;
        let linked = false;
        if (isInventoryCandidate(data.direction, item)) {
          linked = await deductForLending(client, item, qtyOf(item), ctx);
        }
        await insertItem(client, lendingId, item, linked);
        await releaseRackIfRequested(client, item, releasedAssets);
      }
      await client.query('COMMIT');
      return { id: lendingId, releasedAssets };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  // 수정 — 방향·상태는 불변(방향 전환은 재고 연동 정합이 깨져 금지, 상태는 반납 처리 전용).
  // 품목은 item_id 기준 보존 갱신: 반납 이력 있는 품목은 유형/코드/수량 잠금,
  // 무이력 품목의 코드/수량 변경은 기존 차감 복귀 후 재차감으로 재계산.
  async update(id, data, items, actor) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: exRows } = await client.query(
        'SELECT * FROM lendings WHERE id = $1 FOR UPDATE', [id]);
      const existing = exRows[0];
      if (!existing) throw new Error('대여 정보를 찾을 수 없습니다.');

      const vendorId = await resolveVendorId(client, data.counterparty);
      await client.query(
        `UPDATE lendings SET counterparty=$1, counterparty_vendor_id=$2,
           loan_date=$3, due_date=$4, notes=$5 WHERE id=$6`,
        [data.counterparty, vendorId, data.loan_date || null,
         data.due_date || null, data.notes || null, id]
      );

      const releasedAssets = [];
      if (existing.status === 'active') {
        const direction = existing.direction;
        const ctx = { counterparty: data.counterparty, actor, notes: `[대여장부 #${id} 수정]` };
        const { rows: oldItems } = await client.query(
          'SELECT * FROM lending_items WHERE lending_id = $1 ORDER BY id FOR UPDATE', [id]);
        const postedById = new Map();
        const newItems = [];
        for (const it of items || []) {
          if (!it.item_type) continue;
          if (it.item_id) postedById.set(parseInt(it.item_id), it);
          else newItems.push(it);
        }

        for (const old of oldItems) {
          const posted = postedById.get(old.id);
          if (!posted) {
            if (old.returned_quantity > 0) {
              throw new Error(`반납 이력이 있는 품목(${old.item_type}:${old.item_code || '-'})은 삭제할 수 없습니다.`);
            }
            if (old.inventory_linked) {
              await restoreForLending(client, old, qtyOf(old), { ...ctx, notes: `[대여장부 #${id}] 품목 삭제 복귀` });
            }
            await client.query('DELETE FROM lending_items WHERE id = $1', [old.id]);
            continue;
          }
          const structuralChange =
            posted.item_type !== old.item_type ||
            (posted.item_code || null) !== (old.item_code || null) ||
            qtyOf(posted) !== qtyOf(old);
          if (old.returned_quantity > 0 && structuralChange) {
            throw new Error(`반납 이력이 있는 품목(${old.item_type}:${old.item_code || '-'})은 유형·코드·수량을 변경할 수 없습니다.`);
          }
          if (structuralChange) {
            if (old.inventory_linked) {
              await restoreForLending(client, old, qtyOf(old), { ...ctx, notes: `[대여장부 #${id}] 품목 수정 재계산(복귀)` });
            }
            let linked = false;
            if (isInventoryCandidate(direction, posted)) {
              linked = await deductForLending(client, posted, qtyOf(posted), ctx);
            }
            await client.query(
              `UPDATE lending_items SET item_type=$1, item_code=$2, quantity=$3,
                 description=$4, asset_id=$5, inventory_linked=$6 WHERE id=$7`,
              [posted.item_type, posted.item_code || null, qtyOf(posted),
               posted.description || null, posted.asset_id || null, linked, old.id]
            );
          } else {
            await client.query(
              'UPDATE lending_items SET description=$1, asset_id=$2 WHERE id=$3',
              [posted.description || null, posted.asset_id || null, old.id]
            );
          }
          await releaseRackIfRequested(client, posted, releasedAssets);
        }

        for (const item of newItems) {
          let linked = false;
          if (isInventoryCandidate(direction, item)) {
            linked = await deductForLending(client, item, qtyOf(item), ctx);
          }
          await insertItem(client, id, item, linked);
          await releaseRackIfRequested(client, item, releasedAssets);
        }
      }
      await client.query('COMMIT');
      return { releasedAssets };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  // 삭제 — 미반납 잔여 차감분을 복귀시킨 뒤 삭제(재고 유실 방지). items는 FK CASCADE.
  async delete(id, actor) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: exRows } = await client.query(
        'SELECT * FROM lendings WHERE id = $1 FOR UPDATE', [id]);
      const existing = exRows[0];
      if (!existing) { await client.query('ROLLBACK'); return; }
      const { rows: items } = await client.query(
        'SELECT * FROM lending_items WHERE lending_id = $1 FOR UPDATE', [id]);
      const ctx = { counterparty: existing.counterparty, actor };
      for (const item of items) {
        const outstanding = qtyOf(item) - (item.returned_quantity || 0);
        if (item.inventory_linked && outstanding > 0) {
          await restoreForLending(client, item, outstanding, { ...ctx, notes: `[대여장부 #${id}] 장부 삭제 복귀` });
        }
      }
      await client.query('DELETE FROM lendings WHERE id = $1', [id]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  // 품목 부분 반납 — 수량 지정. 전 품목 완납 시 status 자동 'returned'.
  // 반환: { completed, item } (라우트 감사로그·플래시용)
  async returnItem(lendingId, itemId, quantity, actor) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: exRows } = await client.query(
        'SELECT * FROM lendings WHERE id = $1 FOR UPDATE', [lendingId]);
      const lending = exRows[0];
      if (!lending) throw new Error('대여 정보를 찾을 수 없습니다.');
      if (lending.status !== 'active') throw new Error('이미 반납 완료된 건입니다.');

      const { rows: itRows } = await client.query(
        'SELECT * FROM lending_items WHERE id = $1 AND lending_id = $2 FOR UPDATE',
        [itemId, lendingId]);
      const item = itRows[0];
      if (!item) throw new Error('품목을 찾을 수 없습니다.');

      const outstanding = qtyOf(item) - (item.returned_quantity || 0);
      const qty = parseInt(quantity) || 0;
      if (qty < 1 || qty > outstanding) {
        throw new Error(`반납 수량이 잘못되었습니다 (잔여 ${outstanding}개).`);
      }

      await client.query(
        'UPDATE lending_items SET returned_quantity = returned_quantity + $1, last_returned_at = NOW() WHERE id = $2',
        [qty, itemId]);
      if (item.inventory_linked) {
        await restoreForLending(client, item, qty,
          { counterparty: lending.counterparty, actor, notes: `[대여장부 #${lendingId}] 품목 반납` });
      }
      const completed = await finalizeIfAllReturned(client, lendingId);
      await client.query('COMMIT');
      return { completed, item };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  // 전 품목 일괄 반납 (기존 [반납] 버튼 의미 유지)
  async returnAll(id, actor) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: exRows } = await client.query(
        'SELECT * FROM lendings WHERE id = $1 FOR UPDATE', [id]);
      const lending = exRows[0];
      if (!lending) throw new Error('대여 정보를 찾을 수 없습니다.');
      if (lending.status !== 'active') throw new Error('이미 반납 완료된 건입니다.');

      const { rows: items } = await client.query(
        'SELECT * FROM lending_items WHERE lending_id = $1 FOR UPDATE', [id]);
      for (const item of items) {
        const outstanding = qtyOf(item) - (item.returned_quantity || 0);
        if (outstanding <= 0) continue;
        await client.query(
          'UPDATE lending_items SET returned_quantity = $1, last_returned_at = NOW() WHERE id = $2',
          [qtyOf(item), item.id]);
        if (item.inventory_linked) {
          await restoreForLending(client, item, outstanding,
            { counterparty: lending.counterparty, actor, notes: `[대여장부 #${id}] 전량 반납` });
        }
      }
      await client.query(
        `UPDATE lendings SET status='returned', return_date=CURRENT_DATE WHERE id=$1`, [id]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  // B-4d-8a: 장애반납 — 기존 notes 앞에 [장애반납] 사유 병합(비고 보존, BUG-1 계열 패턴)
  // BL-13: 품목도 전량 반납 처리(수명주기 불변식). inbound 전용 플로우라 재고 연동 없음이
  // 정상이나, 만약 linked 품목이 있으면 잔여분 복귀(방어).
  async markFaultReturned(id, { reason, expected_return_date, fault_notes }, actor) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: exRows } = await client.query(
        'SELECT * FROM lendings WHERE id = $1 FOR UPDATE', [id]);
      const lending = exRows[0];
      if (!lending) throw new Error('대여 정보를 찾을 수 없습니다.');

      const { rows: items } = await client.query(
        'SELECT * FROM lending_items WHERE lending_id = $1 FOR UPDATE', [id]);
      for (const item of items) {
        const outstanding = qtyOf(item) - (item.returned_quantity || 0);
        if (outstanding <= 0) continue;
        await client.query(
          'UPDATE lending_items SET returned_quantity = $1, last_returned_at = NOW() WHERE id = $2',
          [qtyOf(item), item.id]);
        if (item.inventory_linked) {
          await restoreForLending(client, item, outstanding,
            { counterparty: lending.counterparty, actor, notes: `[대여장부 #${id}] 장애반납` });
        }
      }

      const existingNotes = lending.notes ? '\n' + lending.notes : '';
      const newNotes = `[장애반납] 사유: ${reason || '장애'}, 예상회수: ${expected_return_date || '미정'}${fault_notes ? '\n' + fault_notes : ''}${existingNotes}`;
      await client.query(
        `UPDATE lendings SET status='returned', return_date=CURRENT_DATE, notes=$1 WHERE id=$2`,
        [newNotes, id]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  async getStats() {
    const { rows } = await pool.query(`
      SELECT direction, status, COUNT(*) as count
      FROM lendings GROUP BY direction, status
    `);
    const { rows: od } = await pool.query(`
      SELECT COUNT(*)::int as count FROM lendings
      WHERE status = 'active' AND due_date IS NOT NULL AND due_date < CURRENT_DATE
    `);
    return { byDirection: rows, overdue: od[0].count };
  }
};

module.exports = Lending;
