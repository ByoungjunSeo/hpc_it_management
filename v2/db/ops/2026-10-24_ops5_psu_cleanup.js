#!/usr/bin/env node
/*
 * OPS-5 (v2.8.0) — PSU 데이터 정리. (★ 운영 적용은 관리자 승인 후 사용자가 직접 실행)
 *
 * 삭제: computing_modules(module_type='psu') 행, module_inventory(module_type='psu') 품목.
 * 보존: 이력 테이블(module_inventory_logs·module_transfer_logs·audit_logs·inventory_audit_items·
 *       inventory_corrections·equipment_usage_logs)은 손대지 않음. 사진은 삭제하지 않고 연결 목록만 출력.
 * 기록: 실행 시 audit_logs에 1건(action='ops_psu_cleanup', 건수·대상 코드/자산 포함).
 * 멱등: 대상이 0이면 아무것도 바꾸지 않음(감사 기록도 남기지 않음).
 * 환경: v2/.env dotenv 로드. DB 기본 127.0.0.1:5433(PGHOST/PGPORT로 변경 가능).
 *
 * 사용(운영=systemd 호스트):
 *   cd /mlcommons_cm/hpc_it_management/v2
 *   NODE_PATH=/mlcommons_cm/hpc_it_management/v2/app/node_modules \
 *     /mlcommons_cm/hpc_it_management/node-v18.20.5-linux-x64/bin/node db/ops/2026-10-24_ops5_psu_cleanup.js \
 *       [--apply] [--backup=/안전한/경로/ops5_psu_backup.json]
 *   (인자 없음 = dry-run: 대상 목록·건수만 출력, 변경 없음)
 *   --apply           단일 트랜잭션으로 삭제 + 감사 기록
 *   --backup=<파일>   삭제 전 대상 행 전체를 JSON으로 저장(권한 600). 자격증명 컬럼은 대상 테이블에 없음.
 */
'use strict';
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const { Pool } = require('pg');

const APPLY = process.argv.includes('--apply');
const backupArg = process.argv.find((a) => a.startsWith('--backup='));
const BACKUP = backupArg ? backupArg.slice('--backup='.length) : null;
const pool = new Pool({
  host: process.env.PGHOST || '127.0.0.1',
  port: parseInt(process.env.PGPORT || '5433', 10),
  user: process.env.POSTGRES_USER || 'itadmin',
  password: process.env.POSTGRES_PASSWORD || '',
  database: process.env.POSTGRES_DB || 'it_assets'
});
// 백업 파일에 비밀값이 섞이지 않았는지 키 이름으로 재확인(대상 테이블엔 원래 없음)
const SECRET_KEY = /pass|secret|token|password_enc/i;

async function main() {
  const client = await pool.connect();
  try {
    const mods = (await client.query(
      `SELECT cm.*, a.management_number AS asset_mgmt, a.status AS asset_status
       FROM computing_modules cm JOIN assets a ON a.id = cm.asset_id
       WHERE cm.module_type = 'psu' ORDER BY cm.asset_id, cm.id`)).rows;
    const items = (await client.query(
      `SELECT * FROM module_inventory WHERE module_type = 'psu' ORDER BY id`)).rows;
    const photos = items.length ? (await client.query(
      `SELECT id, entity_type, entity_id, file_path FROM photos WHERE entity_type = 'module' AND entity_id = ANY($1) ORDER BY id`,
      [items.map((i) => i.id)])).rows : [];
    const keepCounts = (await client.query(
      `SELECT (SELECT count(*) FROM module_inventory_logs WHERE item_code = ANY($1)) AS mil,
              (SELECT count(*) FROM module_transfer_logs WHERE module_type = 'psu') AS mtl,
              (SELECT count(*) FROM inventory_audit_items WHERE module_type = 'psu' OR item_code = ANY($1)) AS iai`,
      [items.map((i) => i.item_code)])).rows[0];

    console.log('[OPS-5] 모드: ' + (APPLY ? 'APPLY(실행)' : 'DRY-RUN(변경 없음)'));
    console.log('[OPS-5] 삭제 대상 computing_modules(psu): ' + mods.length + '행');
    mods.forEach((m) => console.log('  - cm#' + m.id + ' asset#' + m.asset_id + ' ' + (m.asset_mgmt || '') + ' [' + m.asset_status + '] ' + (m.model || '') + ' x' + m.count + ' spec=' + (m.specification || '-') + ' owner=' + (m.owner || '-')));
    console.log('[OPS-5] 삭제 대상 module_inventory(psu): ' + items.length + '품목');
    items.forEach((i) => console.log('  - inv#' + i.id + ' ' + i.item_code + ' owner=' + i.owner + ' total=' + i.total_quantity + ' storage=' + i.storage_quantity + ' in_use=' + i.in_use_quantity + ' spare=' + i.spare_quantity));
    console.log('[OPS-5] 연결 사진(삭제 안 함, 처리 별도): ' + photos.length + '건');
    photos.forEach((p) => console.log('  - photo#' + p.id + ' module#' + p.entity_id + ' ' + p.file_path));
    console.log('[OPS-5] 보존 이력: module_inventory_logs ' + keepCounts.mil + ' · module_transfer_logs ' + keepCounts.mtl + ' · inventory_audit_items ' + keepCounts.iai);

    if (!mods.length && !items.length) { console.log('[OPS-5] 대상 0 — 변경 없음(멱등).'); return; }
    if (!APPLY) { console.log('[OPS-5] dry-run 종료. 실행하려면 --apply'); return; }

    if (BACKUP) {
      const payload = { created_at: new Date().toISOString(), computing_modules: mods, module_inventory: items, photos_linked: photos };
      const bad = [];
      const scan = (o, p) => { if (o && typeof o === 'object') Object.keys(o).forEach((k) => { if (SECRET_KEY.test(k)) bad.push(p + '.' + k); scan(o[k], p + '.' + k); }); };
      scan(payload, '$');
      if (bad.length) throw new Error('백업에 비밀 키 의심 필드: ' + bad.join(','));
      fs.writeFileSync(BACKUP, JSON.stringify(payload, null, 1), { mode: 0o600 });
      console.log('[OPS-5] 백업 저장: ' + BACKUP + ' (cm ' + mods.length + ' / inv ' + items.length + ')');
    }

    await client.query('BEGIN');
    const d1 = await client.query(`DELETE FROM computing_modules WHERE module_type = 'psu' AND id = ANY($1)`, [mods.map((m) => m.id)]);
    const d2 = await client.query(`DELETE FROM module_inventory WHERE module_type = 'psu' AND id = ANY($1)`, [items.map((i) => i.id)]);
    if (d1.rowCount !== mods.length || d2.rowCount !== items.length) {
      throw new Error('삭제 행수 불일치 cm ' + d1.rowCount + '/' + mods.length + ' inv ' + d2.rowCount + '/' + items.length);
    }
    await client.query(
      `INSERT INTO audit_logs (user_id, username, action, target_type, target_id, target_label, details)
       VALUES (NULL, 'ops-script', 'ops_psu_cleanup', 'module_inventory', NULL, 'OPS-5 PSU 정리', $1)`,
      [JSON.stringify({
        deleted_computing_modules: d1.rowCount, deleted_inventory_items: d2.rowCount,
        item_codes: items.map((i) => i.item_code), asset_ids: Array.from(new Set(mods.map((m) => m.asset_id))),
        photos_linked: photos.map((p) => p.id), history_preserved: keepCounts
      })]);
    await client.query('COMMIT');
    console.log('[OPS-5] 완료: computing_modules ' + d1.rowCount + '행, module_inventory ' + d2.rowCount + '품목 삭제 + 감사 1건');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('[OPS-5] 실패(롤백): ' + e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}
main();
