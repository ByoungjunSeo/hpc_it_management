#!/usr/bin/env node
/**
 * B-6e: subnets 테이블 신설 + 기존 ip_addresses 대역 소급 등록 (기존 DB용)
 *
 * 신규 설치는 db/02_schema_assets.sql이 처리하므로 이 스크립트는 "이미 데이터가 있는
 * 기존 v2 DB"에만 실행한다. 멱등 — subnets가 이미 있으면 소급만 보충한다.
 *
 * 사용:
 *   node scripts/migrate-add-subnets.js --dry-run   # 계획만
 *   node scripts/migrate-add-subnets.js             # 적용 (사전 백업 확인)
 *
 * ★ 실행 전 반드시 pg_dump 백업 (스크립트가 backups/에 최근 dump 존재를 확인·경고).
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Pool } = require('pg');

// 소급 등록 시 이름(label) 매칭 — appConfig.subnets 재사용
const appConfig = require('../app/config/app');

const dryRun = process.argv.includes('--dry-run');

async function main() {
  // 0) 사전 백업 확인 (backups/에 .dump 존재 여부)
  const backupDir = path.join(__dirname, '..', 'backups');
  const hasBackup = fs.existsSync(backupDir) &&
    fs.readdirSync(backupDir).some(f => f.endsWith('.dump'));
  if (!dryRun && !hasBackup) {
    console.error('⚠ backups/에 pg_dump(.dump)가 없습니다. 먼저 백업 후 실행하세요:');
    console.error('  docker exec it-assets-db pg_dump -U itadmin -d it_assets --format=custom > backups/pre_subnets.dump');
    process.exit(1);
  }

  const pool = new Pool({
    host: process.env.PGHOST || '127.0.0.1',
    port: parseInt(process.env.PGPORT || '5433', 10),
    database: process.env.POSTGRES_DB,
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
  });
  const client = await pool.connect();

  try {
    console.log(`=== B-6e subnets 마이그레이션 (${dryRun ? 'DRY RUN' : '적용'}) ===`);

    // 1) subnets 테이블 생성 (멱등)
    const ddl = `
      CREATE TABLE IF NOT EXISTS subnets (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        cidr TEXT NOT NULL UNIQUE,
        network_zone TEXT NOT NULL
          CHECK(network_zone IN ('office', 'hpc', 'aidc')),
        description TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        created_by TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_subnets_zone ON subnets(network_zone);
    `;

    // 2) 기존 ip_addresses에서 DISTINCT 대역 → 소급 대상
    const { rows: existing } = await client.query(
      `SELECT DISTINCT subnet, network_zone FROM ip_addresses ORDER BY subnet`
    );
    // 이름 매칭: appConfig.subnets(cidr==subnet)의 label, 없으면 cidr 그대로
    const labelOf = (cidr) => {
      const m = (appConfig.subnets || []).find(s => s.subnet === cidr);
      return m ? m.label : cidr;
    };

    console.log(`소급 대상 대역: ${existing.length}개`);
    existing.forEach(r => console.log(`  ${r.subnet} [${r.network_zone}] → name="${labelOf(r.subnet)}"`));

    if (dryRun) {
      console.log('\nDRY RUN — 변경 없음.');
      return;
    }

    await client.query('BEGIN');
    await client.query(ddl);
    let inserted = 0;
    for (const r of existing) {
      // 이미 있으면 skip (cidr UNIQUE) — 멱등
      const res = await client.query(
        `INSERT INTO subnets (name, cidr, network_zone, created_by)
         VALUES ($1, $2, $3, 'migration')
         ON CONFLICT (cidr) DO NOTHING`,
        [labelOf(r.subnet), r.subnet, r.network_zone]
      );
      inserted += res.rowCount;
    }
    await client.query('COMMIT');

    // 3) 검증
    const { rows: cnt } = await client.query('SELECT COUNT(*) AS n FROM subnets');
    const { rows: ipcnt } = await client.query('SELECT COUNT(*) AS n FROM ip_addresses');
    console.log(`\n적용 완료: subnets ${inserted}행 신규(총 ${cnt[0].n}) / ip_addresses ${ipcnt[0].n}행(무손상)`);
    if (parseInt(cnt[0].n) !== existing.length) {
      console.warn(`⚠ subnets 행수(${cnt[0].n}) ≠ DISTINCT 대역(${existing.length}) — 확인 필요`);
    }
  } catch (err) {
    if (!dryRun) await client.query('ROLLBACK').catch(() => {});
    console.error('실패(롤백됨):', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
