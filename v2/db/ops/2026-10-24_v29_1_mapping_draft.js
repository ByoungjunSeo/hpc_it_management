#!/usr/bin/env node
/*
 * v2.9 단계 1 — 기존 module_inventory 품목 → 제안 규격 코드 대응표 초안(검토용).
 * 기본: DB는 SELECT만, 결과는 파일로만(git 밖). 운영 기존 테이블 무변경.
 *   mapping_draft.csv  (UTF-8 BOM, 엑셀용) 옛 코드·소유·업체·제조사·모델(시리얼 마스킹)·수량·제안 규격·신뢰도·이유·합쳐지는 옛 코드
 *   unresolved.csv     자동 해석 안 된 품목(보류 포함)과 빠진 필드
 *   summary.json       요약 통계 + 수량 영향 미리보기(규격별, 비활성 장비 장착분 포함 기준)
 * --apply-db: 새 테이블(module_specs·module_part_aliases·module_spec_mapping)에 초안 반영 — 단일 트랜잭션.
 *   격리 리허설 전용: 운영 포트(5433) 접속이면 거부(운영 반영은 검토·승인 후 별도 단계).
 * 사용:
 *   cd /mlcommons_cm/hpc_it_management/v2
 *   NODE_PATH=<repo>/v2/app/node_modules <node> db/ops/2026-10-24_v29_1_mapping_draft.js [--out=~/v29-review] [--apply-db]
 * 환경: v2/.env dotenv(PGHOST/PGPORT/POSTGRES_* 로 덮어쓰기 가능). DB 기본 127.0.0.1:5433.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const { Pool } = require('pg');
const sc = require('../../app/services/specCatalog');

const arg = (k) => { const a = process.argv.find((x) => x.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : null; };
const APPLY_DB = process.argv.includes('--apply-db');
const OUT = (arg('out') || path.join(os.homedir(), 'v29-review')).replace(/^~(?=$|\/)/, os.homedir());
const PORT = parseInt(process.env.PGPORT || '5433', 10);
const pool = new Pool({ host: process.env.PGHOST || '127.0.0.1', port: PORT, user: process.env.POSTGRES_USER || 'itadmin',
  password: process.env.POSTGRES_PASSWORD || '', database: process.env.POSTGRES_DB || 'it_assets' });
if (APPLY_DB && PORT === 5433) { console.error('[v29-1] --apply-db는 격리 리허설 전용입니다(운영 포트 5433 거부).'); process.exit(2); }

const csvCell = (v) => { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const csv = (rows) => '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
const aliasNorm = (type, r, model) => (type === 'memory' && r.attrs && r.attrs.part_norm) ? r.attrs.part_norm
  : String(model || '').toUpperCase().replace(/\(SN[^)]*\)/g, '').replace(/[\s_]+/g, ' ').trim() || null;

async function main() {
  const c = await pool.connect();
  try {
    await c.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');   // 읽기 단계는 읽기 전용 세션
    const items = (await c.query(`SELECT mi.id, mi.module_type, mi.item_code, mi.manufacturer, mi.model, mi.capacity, mi.specification,
        mi.total_quantity, mi.storage_quantity, mi.in_use_quantity, mi.owner, mi.owner_vendor_id, v.vendor_name
      FROM module_inventory mi LEFT JOIN vendor_info v ON v.id = mi.owner_vendor_id ORDER BY mi.module_type, mi.item_code`)).rows;
    // 품목별 장착 현황(자산 상태별) — specification = item_code 연결분
    const inst = {};
    (await c.query(`SELECT cm.specification AS code, a.status, SUM(cm.count)::int AS n,
        BOOL_AND(COALESCE(cm.is_onboard,0)::int = 1) AS all_onboard, COUNT(*)::int AS rows
      FROM computing_modules cm JOIN assets a ON a.id = cm.asset_id
      WHERE cm.specification IS NOT NULL AND cm.specification <> '' GROUP BY 1, 2`)).rows
      .forEach((r) => { const x = inst[r.code] = inst[r.code] || { active: 0, inactive: 0, maintenance: 0, other: 0, rows: 0, onboard_rows: 0 };
        x[['active', 'inactive', 'maintenance'].includes(r.status) ? r.status : 'other'] += r.n; x.rows += r.rows; if (r.all_onboard) x.onboard_rows += r.rows; });
    // 비교 기준(Phase A 186): 자사 모듈 중 비활성·점검 자산 장착 수량(연결 여부 무관)
    const phaseA = (await c.query(`SELECT COALESCE(SUM(cm.count),0)::int n, COUNT(*)::int r FROM computing_modules cm JOIN assets a ON a.id=cm.asset_id
      WHERE cm.owner='company' AND a.status IN ('inactive','maintenance')`)).rows[0];
    await c.query('COMMIT').catch(() => {});

    const psu = items.filter((i) => i.module_type === 'psu');
    const rows = items.filter((i) => i.module_type !== 'psu').map((i) => {
      const r = sc.generate({ module_type: i.module_type, manufacturer: i.manufacturer, model: i.model, capacity: i.capacity, specification: i.specification, legacy_code: i.item_code, owner: i.owner });
      const x = inst[i.item_code] || { active: 0, inactive: 0, maintenance: 0, other: 0, rows: 0, onboard_rows: 0 };
      if (r.inventory && ['network', 'raid'].includes(i.module_type) && x.rows > 0 && x.onboard_rows === x.rows) {
        Object.assign(r, { inventory: false, spec_code: null, exclude_reason: '온보드(장착 ' + x.rows + '행 모두 is_onboard)', reason: '재고 아님: 온보드(장착 행 모두 is_onboard)', serialized: false });
      }
      return { i, r, x };
    });
    // 규격별 묶음
    const bySpec = {};
    rows.filter((o) => o.r.inventory && o.r.spec_code).forEach((o) => { (bySpec[o.r.spec_code] = bySpec[o.r.spec_code] || []).push(o); });
    const method = (o) => (!o.r.inventory ? 'rule' : (o.r.spec_code && !o.r.hold ? 'rule' : 'unresolved'));
    const header = ['옛 코드', '유형', '소유', '업체명', '제조사', '모델(시리얼 마스킹)', '총', '장비실', '사용(활성)', '비활성·점검 장착', '제안 규격 코드', '방법', '신뢰도', '시리얼 관리', '이유', '빠진 필드', '같은 규격으로 합쳐지는 옛 코드'];
    const out = [header];
    rows.forEach((o) => {
      const peers = o.r.spec_code ? bySpec[o.r.spec_code].map((p) => p.i.item_code).filter((k) => k !== o.i.item_code) : [];
      out.push([o.i.item_code, o.i.module_type, o.i.owner === 'vendor' ? '업체' : '자사', o.i.vendor_name || '', o.i.manufacturer || '', sc.maskSerial(o.i.model),
        o.i.total_quantity, o.i.storage_quantity, o.i.in_use_quantity, o.x.inactive + o.x.maintenance,
        o.r.inventory ? (o.r.spec_code || '') : '(재고 아님)', method(o), o.r.confidence, o.r.serialized ? 'Y' : '', o.r.reason, (o.r.unresolved_fields || []).join('+'), peers.join(' | ')]);
    });
    const unres = [['옛 코드', '유형', '소유', '모델(시리얼 마스킹)', '용량', '현 스펙', '제안(부분)', '빠진 필드', '이유', '보류']];
    rows.filter((o) => o.r.inventory && (!o.r.spec_code || o.r.hold || (o.r.unresolved_fields || []).length)).forEach((o) => {
      unres.push([o.i.item_code, o.i.module_type, o.i.owner === 'vendor' ? '업체' : '자사', sc.maskSerial(o.i.model), o.i.capacity || '', sc.maskSerial(o.i.specification || ''),
        o.r.spec_code || '', (o.r.unresolved_fields || []).join('+'), o.r.reason, o.r.hold ? 'Y' : '']);
    });
    // 수량 영향 미리보기(쓰기 없음)
    const qty = Object.keys(bySpec).sort().map((k) => {
      const g = bySpec[k];
      const s = (f) => g.reduce((a, o) => a + (Number(f(o)) || 0), 0);
      const total = s((o) => o.i.total_quantity), storage = s((o) => o.i.storage_quantity), inUse = s((o) => o.i.in_use_quantity);
      const inact = s((o) => o.x.inactive + o.x.maintenance);
      return { spec_code: k, legacy_codes: g.length, owners: [...new Set(g.map((o) => o.i.owner))].join('+'), total, storage, in_use_active: inUse, installed_inactive: inact, total_incl_inactive: storage + inUse + inact, diff: inact };
    });
    const count = (f) => rows.filter(f).length;
    const summary = {
      items_total: items.length, psu_items: psu.length, items_considered: rows.length,
      specs: Object.keys(bySpec).length,
      by_confidence: { high: count((o) => o.r.inventory && o.r.spec_code && o.r.confidence === 'high'), medium: count((o) => o.r.inventory && o.r.spec_code && o.r.confidence === 'medium'), low: count((o) => o.r.inventory && o.r.spec_code && o.r.confidence === 'low') },
      merged_groups: Object.values(bySpec).filter((g) => g.length > 1).length,
      merged_items: Object.values(bySpec).filter((g) => g.length > 1).reduce((a, g) => a + g.length, 0),
      unresolved: unres.length - 1, unresolved_no_code: count((o) => o.r.inventory && (!o.r.spec_code || o.r.hold)),
      hold: count((o) => o.r.hold), excluded: count((o) => !o.r.inventory),
      excluded_list: rows.filter((o) => !o.r.inventory).map((o) => o.i.item_code + ': ' + o.r.exclude_reason),
      serialized_specs: Object.values(bySpec).filter((g) => g[0].r.serialized).length,
      qty_totals: { current_total: qty.reduce((a, q) => a + q.total, 0), installed_inactive_linked: qty.reduce((a, q) => a + q.installed_inactive, 0),
        total_incl_inactive: qty.reduce((a, q) => a + q.total_incl_inactive, 0), phaseA_company_inactive_all: phaseA.n, phaseA_rows: phaseA.r },
      qty_by_spec: qty
    };
    fs.mkdirSync(OUT, { recursive: true, mode: 0o700 }); fs.chmodSync(OUT, 0o700);
    const w = (f, d) => { fs.writeFileSync(path.join(OUT, f), d, { mode: 0o600 }); fs.chmodSync(path.join(OUT, f), 0o600); };
    w('mapping_draft.csv', csv(out)); w('unresolved.csv', csv(unres)); w('summary.json', JSON.stringify(summary, null, 1));
    console.log('[v29-1] 품목 ' + summary.items_total + ' (psu ' + summary.psu_items + ') → 규격 ' + summary.specs + ' · 신뢰도 ' + JSON.stringify(summary.by_confidence) +
      ' · 합쳐지는 묶음 ' + summary.merged_groups + '(' + summary.merged_items + '품목) · 미해결 ' + summary.unresolved + '(코드 없음 ' + summary.unresolved_no_code + ', 보류 ' + summary.hold + ') · 재고 아님 ' + summary.excluded);
    console.log('[v29-1] 수량: 현재 총 ' + summary.qty_totals.current_total + ' · 비활성·점검 장착(연결분) +' + summary.qty_totals.installed_inactive_linked + ' → ' + summary.qty_totals.total_incl_inactive +
      ' (참고: 자사·비활성·점검 장착 전체 ' + phaseA.n + '개/' + phaseA.r + '행)');
    console.log('[v29-1] 출력: ' + OUT + ' (mapping_draft.csv · unresolved.csv · summary.json)');

    if (APPLY_DB) {
      await c.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE');
      await c.query('BEGIN');
      const specId = {};
      for (const k of Object.keys(bySpec).sort()) {
        const o = bySpec[k][0];
        const r = await c.query(`INSERT INTO module_specs (spec_code, module_type, attrs, manufacturer, display_name, serialized)
          VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (spec_code) DO UPDATE SET attrs = EXCLUDED.attrs, serialized = EXCLUDED.serialized, updated_at = NOW() RETURNING id`,
          [k, o.i.module_type, JSON.stringify(Object.assign({}, o.r.attrs, { part_norm: undefined })), o.r.attrs.manufacturer || o.i.manufacturer || null, k, o.r.serialized]);
        specId[k] = r.rows[0].id;
      }
      let aliasN = 0, aliasClash = [];
      for (const k of Object.keys(bySpec)) for (const o of bySpec[k]) {
        const norm = aliasNorm(o.i.module_type, o.r, o.i.model); if (!norm) continue;
        const ex = (await c.query('SELECT spec_id FROM module_part_aliases WHERE module_type=$1 AND part_number_norm=$2', [o.i.module_type, norm])).rows[0];
        if (ex && ex.spec_id !== specId[k]) { aliasClash.push(norm); continue; }
        await c.query(`INSERT INTO module_part_aliases (part_number_norm, part_number_raw_samples, module_type, spec_id, source)
          VALUES ($1, $2, $3, $4, 'rule') ON CONFLICT (module_type, part_number_norm) DO UPDATE
          SET part_number_raw_samples = (SELECT jsonb_agg(DISTINCT x) FROM jsonb_array_elements(module_part_aliases.part_number_raw_samples || EXCLUDED.part_number_raw_samples) x)`,
          [norm, JSON.stringify([sc.maskSerial(o.i.model)]), o.i.module_type, specId[k]]);
        aliasN++;
      }
      for (const o of rows) {
        await c.query(`INSERT INTO module_spec_mapping (legacy_item_code, module_inventory_id, owner, owner_vendor_id, proposed_spec_code, spec_id, method, confidence, reason)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (legacy_item_code) DO UPDATE SET proposed_spec_code=EXCLUDED.proposed_spec_code, spec_id=EXCLUDED.spec_id,
          method=EXCLUDED.method, confidence=EXCLUDED.confidence, reason=EXCLUDED.reason`,
          [o.i.item_code, o.i.id, o.i.owner, o.i.owner_vendor_id, o.r.inventory ? o.r.spec_code : null, o.r.inventory && o.r.spec_code ? specId[o.r.spec_code] : null,
            method(o), o.r.confidence, o.r.reason]);
      }
      await c.query('COMMIT');
      console.log('[v29-1] --apply-db: 규격 ' + Object.keys(specId).length + ' · 별칭 ' + aliasN + (aliasClash.length ? ' (충돌 건너뜀 ' + aliasClash.length + ')' : '') + ' · 대응 ' + rows.length + '행');
    }
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch (_) {}
    console.error('[v29-1] 실패: ' + e.message); process.exitCode = 1;
  } finally { c.release(); await pool.end(); }
}
main();
