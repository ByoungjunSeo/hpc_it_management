#!/usr/bin/env node
/*
 * OPS-6 (v2.8.0) — 장비실 블레이드 현행화(2안 확정): 개별 등록된 노드(asset_number *_A~*_D)를 섀시-노드 구조로 묶는다.
 * (★ 운영 적용은 관리자 승인 후 사용자가 직접 실행)
 *
 * 섀시: 자산 신설. asset_number=설정값(20AFD392 등), management_number=<prefix><NN>(실행 시 DB에서 다음 번호 계산 —
 *       assets·equipment_usage_logs의 '<prefix>NN' / '<prefix>NN-N*' 최대값+1, 없으면 01. 설정 순서대로 배정).
 *       유형·모델·제조사·소유·업체·상태·서버실은 노드 공통값에서 추론, 랙 없음, rack_unit_size=u_size*3(1/3U 단위).
 * 노드: 삭제하지 않고 parent_asset_id=섀시, node_index=1..N(설정 nodes 순서), blade_slot=asset_number 접미 문자(A~D),
 *       위치(room/rack/U)=NULL(BUG-9 가드: 자식은 자체 위치 없음 — 운영 블레이드 글루시스-007/008과 동일),
 *       management_number="<섀시 관리번호>-N<i>", asset_number=NULL(실물 태그는 섀시 기준).
 * 입출고 이력(equipment_usage_logs): 그 노드 asset_id로 묶인 행 중 옛 관리번호 → 새 관리번호, 옛 asset_number → NULL.
 *       (asset_number를 남기면 이력 편집 저장 시 routes/inventory.js의 asset_number 반영 경로로 옛 번호가 자산에 재기록됨)
 *       감사 로그(audit_logs)는 재작성하지 않음(옛 번호 유지).
 * 단일 트랜잭션, 감사 기록(섀시 생성 1건 + 노드 변경 N건), 멱등(섀시가 있으면 그 자식(node_index 순)을 노드로 보고 차이만 반영).
 * 환경: v2/.env dotenv. DB 기본 127.0.0.1:5433(PGHOST/PGPORT 등으로 변경 가능).
 *
 * 사용:
 *   cd /mlcommons_cm/hpc_it_management/v2
 *   NODE_PATH=/mlcommons_cm/hpc_it_management/v2/app/node_modules \
 *     /mlcommons_cm/hpc_it_management/node-v18.20.5-linux-x64/bin/node db/ops/2026-10-24_ops6_blade_chassis.js \
 *       [--config=db/ops/2026-10-24_ops6_blade_chassis.config.json] [--apply]
 *   (--apply 없으면 dry-run: 생성·변경 예정 내역과 변경 전/후 번호 표만 출력)
 */
'use strict';
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const { Pool } = require('pg');

const arg = (k) => { const a = process.argv.find((x) => x.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : null; };
const APPLY = process.argv.includes('--apply');
if (arg('plan') && arg('plan') !== '2') { console.error('2안 전용 스크립트입니다(--plan 생략 또는 --plan=2).'); process.exit(2); }
const CONFIG = arg('config') || path.resolve(__dirname, '2026-10-24_ops6_blade_chassis.config.json');
const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
if (!/^[A-Za-z0-9-]+-$/.test(cfg.management_prefix || '')) { console.error('config.management_prefix 형식 오류(예: "TPC-SV-BL-2U-")'); process.exit(2); }
const pool = new Pool({
  host: process.env.PGHOST || '127.0.0.1',
  port: parseInt(process.env.PGPORT || '5433', 10),
  user: process.env.POSTGRES_USER || 'itadmin',
  password: process.env.POSTGRES_PASSWORD || '',
  database: process.env.POSTGRES_DB || 'it_assets'
});

function common(nodes, k) {
  const vals = Array.from(new Set(nodes.map((n) => (n[k] == null ? null : n[k]))));
  if (vals.length !== 1) throw new Error('노드 간 ' + k + ' 불일치: ' + JSON.stringify(vals));
  return vals[0];
}
function chassisModel(nodes) {
  const stripped = nodes.map((n) => String(n.model_name || '').replace(/\s+Node\s+[A-Z0-9]+\s*$/i, '').trim());
  if (new Set(stripped).size === 1) return stripped[0] || null;
  let p = stripped[0];
  stripped.forEach((s) => { while (s.indexOf(p) !== 0) p = p.slice(0, -1); });
  return p.trim() || null;
}
function slotOf(assetNumber) { const m = String(assetNumber || '').match(/[_-]([A-Za-z0-9])$/); return m ? m[1].toUpperCase() : null; }
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function audit(c, action, targetId, label, details) {
  await c.query(`INSERT INTO audit_logs (user_id, username, action, target_type, target_id, target_label, details)
                 VALUES (NULL, 'ops-script', $1, 'asset', $2, $3, $4)`, [action, targetId, label, JSON.stringify(details)]);
}

// 다음 섀시 번호: assets + 입출고 이력의 '<prefix>NN' 및 '<prefix>NN-N*' 최대값 + 1
async function nextChassisSeq(c, prefix) {
  const re = '^' + esc(prefix) + '([0-9]+)(-N[0-9]+)?$';
  const r = await c.query(`SELECT max(substring(m FROM $1)::int) AS mx FROM (
      SELECT management_number m FROM assets WHERE management_number ~ $2
      UNION ALL SELECT management_number FROM equipment_usage_logs WHERE management_number ~ $2) t`,
    ['^' + esc(prefix) + '([0-9]+)', re]);
  return (r.rows[0].mx || 0) + 1;
}

async function main() {
  const c = await pool.connect();
  let changes = 0;
  const table = [];
  try {
    console.log('[OPS-6] 모드: ' + (APPLY ? 'APPLY' : 'DRY-RUN') + ' · 2안(관리번호 변경 + 노드 asset_number 비움) · config=' + CONFIG);
    if (APPLY) await c.query('BEGIN');
    let seq = await nextChassisSeq(c, cfg.management_prefix);
    for (const g of cfg.chassis) {
      // 섀시: 이미 있으면 재사용(멱등) — 그 관리번호 유지
      let chassis = (await c.query(`SELECT * FROM assets WHERE asset_number = $1`, [g.asset_number])).rows;
      if (chassis.length > 1) throw new Error('섀시 asset_number 중복: ' + g.asset_number);
      chassis = chassis[0] || null;
      let ordered;
      if (chassis) {
        // 재실행: 노드 asset_number는 이미 비었을 수 있으므로 섀시 자식(node_index 순)으로 식별
        ordered = (await c.query(`SELECT * FROM assets WHERE parent_asset_id = $1 ORDER BY node_index NULLS LAST, id`, [chassis.id])).rows;
        const leftover = (await c.query(`SELECT id, asset_number FROM assets WHERE asset_number = ANY($1)`, [g.nodes])).rows.filter((r) => !ordered.some((o) => o.id === r.id));
        if (leftover.length) throw new Error('섀시 밖에 남은 노드: ' + leftover.map((r) => r.asset_number + '#' + r.id).join(','));
        if (ordered.length !== g.nodes.length) throw new Error('섀시 asset#' + chassis.id + ' 자식 수 ' + ordered.length + ' ≠ 설정 ' + g.nodes.length);
      } else {
        const nodes = (await c.query(`SELECT * FROM assets WHERE asset_number = ANY($1)`, [g.nodes])).rows;
        const byNum = {}; nodes.forEach((n) => { if (byNum[n.asset_number]) throw new Error('노드 asset_number 중복: ' + n.asset_number); byNum[n.asset_number] = n; });
        const miss = g.nodes.filter((x) => !byNum[x]);
        if (miss.length) throw new Error('노드 미발견: ' + miss.join(','));
        ordered = g.nodes.map((x) => byNum[x]);
        const foreign = ordered.filter((n) => n.parent_asset_id);
        if (foreign.length) throw new Error('이미 다른 부모에 묶인 노드: ' + foreign.map((n) => n.asset_number + '→' + n.parent_asset_id).join(','));
      }
      const chassisMgmt = chassis ? chassis.management_number : cfg.management_prefix + String(seq++).padStart(2, '0');
      console.log('\n[섀시] asset_number=' + g.asset_number + ' 관리번호=' + chassisMgmt + (chassis ? ' (기존 asset#' + chassis.id + ')' : ' (신설, 다음 번호)') + ' 노드 ' + ordered.length + '대');

      if (!chassis) {
        const clash = (await c.query(`SELECT id FROM assets WHERE management_number = $1`, [chassisMgmt])).rows;
        if (clash.length) throw new Error('섀시 관리번호 이미 사용 중: ' + chassisMgmt + ' → asset#' + clash[0].id);
        const spec = {
          asset_number: g.asset_number, management_number: chassisMgmt,
          asset_type: common(ordered, 'asset_type'), ownership: common(ordered, 'ownership'), vendor_id: common(ordered, 'vendor_id'),
          model_name: chassisModel(ordered), manufacturer: common(ordered, 'manufacturer'), status: common(ordered, 'status'),
          room_id: common(ordered, 'room_id'), rack_unit_size: (g.u_size || 2) * 3,
          notes: 'OPS-6 블레이드 섀시 — 노드 ' + ordered.length + '대'   // 옛 번호는 감사 로그(ops_blade_*)에만 남김(본문 잔존 0)
        };
        console.log('  + 섀시 생성 예정: ' + JSON.stringify(spec));
        table.push(['섀시', '(신설)', '-', '-', g.asset_number, chassisMgmt, '']);
        changes++;
        if (APPLY) {
          const r = await c.query(
            `INSERT INTO assets (asset_number, management_number, asset_type, ownership, vendor_id, model_name, manufacturer, status, room_id, rack_unit_size, notes)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
            [spec.asset_number, spec.management_number, spec.asset_type, spec.ownership, spec.vendor_id, spec.model_name, spec.manufacturer, spec.status, spec.room_id, spec.rack_unit_size, spec.notes]);
          chassis = r.rows[0];
          await audit(c, 'ops_blade_chassis_create', chassis.id, spec.management_number, { plan: 2, chassis: spec, nodes: ordered.map((n) => n.id) });
          console.log('    → 섀시 asset#' + chassis.id);
        }
      } else {
        console.log('  = 섀시 존재 — 생성 건너뜀');
      }

      for (let i = 0; i < ordered.length; i++) {
        const n = ordered[i];
        const want = {
          parent_asset_id: chassis ? chassis.id : '(신설 섀시)', node_index: i + 1,
          blade_slot: slotOf(n.asset_number) || n.blade_slot,
          room_id: null, rack_id: null, rack_unit_start: null,
          management_number: chassisMgmt + '-N' + (i + 1), asset_number: null
        };
        const diff = {};
        Object.keys(want).forEach((k) => { if ((n[k] == null ? null : n[k]) !== want[k]) diff[k] = [n[k], want[k]]; });
        const clash = (await c.query(`SELECT id FROM assets WHERE management_number = $1 AND id <> $2`, [want.management_number, n.id])).rows;
        if (clash.length) throw new Error('노드 새 관리번호 충돌: ' + want.management_number + ' → asset#' + clash[0].id);
        // 이 노드 asset_id로 묶인 입출고 이력: 옛 관리번호 행 / 옛 asset_number 행
        const eulMgmt = (await c.query(`SELECT id FROM equipment_usage_logs WHERE asset_id = $1 AND management_number IS DISTINCT FROM $2 ORDER BY id`, [n.id, want.management_number])).rows.map((r) => r.id);
        const eulAnum = (await c.query(`SELECT id FROM equipment_usage_logs WHERE asset_id = $1 AND asset_number IS NOT NULL ORDER BY id`, [n.id])).rows.map((r) => r.id);
        const orphan = n.asset_number || n.management_number !== want.management_number
          ? Number((await c.query(`SELECT count(*) FROM equipment_usage_logs WHERE asset_id IS NULL AND (management_number = $1 OR asset_number = $2)`, [n.management_number, n.asset_number])).rows[0].count) : 0;
        if (!Object.keys(diff).length && !eulMgmt.length && !eulAnum.length) { console.log('  = 노드 asset#' + n.id + ' ' + want.management_number + ' 변경 없음(이미 반영)'); continue; }
        changes++;
        table.push(['노드' + (i + 1), '#' + n.id, n.asset_number || '(NULL)', n.management_number || '(NULL)', '(NULL)', want.management_number, 'EUL 관리번호 ' + eulMgmt.length + '·자산번호 ' + eulAnum.length]);
        console.log('  ~ 노드 asset#' + n.id + ' ' + JSON.stringify(diff) +
          ' · 입출고 이력 관리번호 ' + eulMgmt.length + '건/자산번호 비움 ' + eulAnum.length + '건' +
          (orphan ? ' · ⚠ asset_id 없는 옛 번호 이력 ' + orphan + '건(갱신 안 함)' : ''));
        if (APPLY) {
          const r = await c.query(
            `UPDATE assets SET parent_asset_id=$1, node_index=$2, blade_slot=$3, room_id=NULL, rack_id=NULL, rack_unit_start=NULL,
                    management_number=$4, asset_number=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=$5`,
            [chassis.id, want.node_index, want.blade_slot, want.management_number, n.id]);
          if (r.rowCount !== 1) throw new Error('노드 갱신 실패 asset#' + n.id);
          if (eulMgmt.length) {
            const u = await c.query(`UPDATE equipment_usage_logs SET management_number=$1 WHERE id = ANY($2)`, [want.management_number, eulMgmt]);
            if (u.rowCount !== eulMgmt.length) throw new Error('이력 관리번호 갱신 행수 불일치 asset#' + n.id);
          }
          if (eulAnum.length) {
            const u = await c.query(`UPDATE equipment_usage_logs SET asset_number=NULL WHERE id = ANY($1)`, [eulAnum]);
            if (u.rowCount !== eulAnum.length) throw new Error('이력 자산번호 갱신 행수 불일치 asset#' + n.id);
          }
          await audit(c, 'ops_blade_node_update', n.id, want.management_number, {
            plan: 2, chassis_id: chassis.id,
            before: Object.fromEntries(Object.keys(diff).map((k) => [k, diff[k][0]])),
            after: Object.fromEntries(Object.keys(diff).map((k) => [k, k === 'parent_asset_id' ? chassis.id : diff[k][1]])),
            eul_mgmt_renamed: eulMgmt, eul_asset_number_cleared: eulAnum
          });
        }
      }
    }
    if (table.length) {
      console.log('\n[변경 전/후 번호 표]');
      console.log(['구분', 'id', '자산번호(전)', '관리번호(전)', '자산번호(후)', '관리번호(후)', '이력 동반'].join(' | '));
      table.forEach((r) => console.log(r.join(' | ')));
    }
    if (APPLY) { await c.query('COMMIT'); console.log('\n[OPS-6] 완료: 변경 ' + changes + '건' + (changes ? '' : ' (멱등 — 이미 반영됨)')); }
    else console.log('\n[OPS-6] dry-run 종료: 예정 변경 ' + changes + '건' + (changes ? '. 실행하려면 --apply' : ' (이미 반영됨)'));
  } catch (e) {
    if (APPLY) { try { await c.query('ROLLBACK'); } catch (_) {} }
    console.error('[OPS-6] 실패' + (APPLY ? '(롤백)' : '') + ': ' + e.message);
    process.exitCode = 1;
  } finally {
    c.release();
    await pool.end();
  }
}
main();
