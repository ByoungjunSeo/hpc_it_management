const { Pool } = require('pg');

// B-5b: 컨테이너 배포 대응 — host도 env 경유 (개발 기본값은 기존과 동일 127.0.0.1:5433)
const pool = new Pool({
  host: process.env.PGHOST || '127.0.0.1',
  port: parseInt(process.env.PGPORT || '5433', 10),
  database: process.env.POSTGRES_DB || 'it_assets',
  user: process.env.POSTGRES_USER || 'itadmin',
  password: process.env.POSTGRES_PASSWORD || '',
});

function closeDb() {
  return pool.end();
}

module.exports = { pool, closeDb };
