const { Pool } = require('pg');

const pool = new Pool({
  host: '127.0.0.1',
  port: parseInt(process.env.PGPORT || '5433', 10),
  database: process.env.POSTGRES_DB || 'it_assets',
  user: process.env.POSTGRES_USER || 'itadmin',
  password: process.env.POSTGRES_PASSWORD || '',
});

function closeDb() {
  return pool.end();
}

module.exports = { pool, closeDb };
