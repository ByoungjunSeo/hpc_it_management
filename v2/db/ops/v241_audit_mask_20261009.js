#!/usr/bin/env node
/*
 * v2.4.1 운영 조치 ⒝ — audit_logs.details의 기존 평문 비밀번호 값만 "***"로 치환. (★ 운영 승인 후 실행)
 *
 * 원칙 예외: 감사 로그 in-place 수정 금지 원칙의 예외 — 비밀정보(평문 비밀번호) 제거 목적에 한해 승인 하에 1회.
 * 보존: 비밀번호 키 "외" 모든 키·값·행 수·행 순서 불변. 비밀번호 키 값만 "***". 멱등(이미 마스킹된 값 건너뜀).
 * 환경: v2/.env dotenv 로드. DB 기본 127.0.0.1:5433.
 * 실행(운영=systemd 호스트):
 *   cd /mlcommons_cm/hpc_it_management/v2
 *   NODE_PATH=/mlcommons_cm/hpc_it_management/v2/app/node_modules \
 *     /mlcommons_cm/hpc_it_management/node-v18.20.5-linux-x64/bin/node db/ops/v241_audit_mask_20261009.js [--dry-run]
 *   --dry-run: 대상 행 id·치환될 키만 출력, UPDATE 없음.
 */
'use strict';
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const { Pool } = require('pg');

const DRY = process.argv.includes('--dry-run') || process.env.DRY_RUN === '1';
const pool = new Pool({
  host: process.env.PGHOST || '127.0.0.1',
  port: parseInt(process.env.PGPORT || '5433', 10),
  user: process.env.POSTGRES_USER || 'itadmin',
  password: process.env.POSTGRES_PASSWORD || '',
  database: process.env.POSTGRES_DB || 'it_assets'
});

const SENSITIVE = new Set(['password','ssh_password','password_enc','bmc_password','sol_password','new_password','cred_passwords','cred_passwords[]','ssh_pass']);
function isSensitive(k){ const lk=String(k).toLowerCase(); return SENSITIVE.has(k) || lk.includes('password') || lk.includes('passwd'); }
const MASK = '***';
const maskAlready = v => v === MASK || v === '***REDACTED***';
function maskDetails(value, touched) {
  if (Array.isArray(value)) return value.map(v => maskDetails(v, touched));
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) {
      if (isSensitive(k) && value[k] && !maskAlready(value[k]) && typeof value[k] !== 'object') { out[k] = MASK; touched.add(k); }
      else out[k] = maskDetails(value[k], touched);
    }
    return out;
  }
  return value;
}

const Q_TARGET = `
  SELECT id, details FROM audit_logs
  WHERE details IS NOT NULL
    AND details::text ~ '"(ssh_password|password|bmc_password|cred_passwords|sol_password|new_password|ssh_pass)[^"]*"\\s*:\\s*"[^"]+"'
    AND details::text !~ '\\*\\*\\*'
  ORDER BY id`;

async function main() {
  const client = await pool.connect();
  try {
    const rows = (await client.query(Q_TARGET)).rows;
    const keys = new Set();
    for (const r of rows) {
      let d; try { d = typeof r.details === 'string' ? JSON.parse(r.details) : r.details; } catch (e) { continue; }
      maskDetails(d, keys);
    }
    console.log(`${DRY ? '=== DRY-RUN (UPDATE 없음) ===\n' : ''}대상 행 수: ${rows.length}`);
    console.log(`대상 id: ${rows.map(r => r.id).join(',')}`);
    console.log(`치환될 비밀번호 키: ${[...keys].join(', ') || '(없음)'}`);
    if (DRY) return;

    await client.query('BEGIN');
    let changed = 0;
    for (const r of rows) {
      let d; try { d = typeof r.details === 'string' ? JSON.parse(r.details) : r.details; } catch (e) { continue; }
      const t = new Set(); const masked = maskDetails(d, t);
      if (t.size === 0) continue;
      await client.query('UPDATE audit_logs SET details=$1 WHERE id=$2', [JSON.stringify(masked), r.id]);
      changed++;
    }
    await client.query('COMMIT');
    console.log(`치환 완료: ${changed}행 (재실행 시 0 — 멱등)`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('실패(롤백):', err.message); process.exitCode = 1;
  } finally {
    client.release(); await pool.end();
  }
}
main();
