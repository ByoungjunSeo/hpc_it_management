const crypto = require('crypto');
const { pool } = require('../config/database');
const { fixRowDates } = require('../utils/dateFix');

// B-4d-9 Date 직렬화 스윕
function fixDates(row) {
  return fixRowDates(row, [], ['created_at']);
}

const SALT_LENGTH = 16;
const ITERATIONS = 100000;
const KEY_LENGTH = 64;
const DIGEST = 'sha512';

function hashPassword(password) {
  const salt = crypto.randomBytes(SALT_LENGTH).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, ITERATIONS, KEY_LENGTH, DIGEST).toString('hex');
  return salt + ':' + hash;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const verify = crypto.pbkdf2Sync(password, salt, ITERATIONS, KEY_LENGTH, DIGEST).toString('hex');
  return hash === verify;
}

const User = {
  async findAll() {
    const { rows } = await pool.query(
      'SELECT id, username, role, display_name, created_at FROM users ORDER BY created_at'
    );
    return rows.map(fixDates);
  },

  async findById(id) {
    const { rows } = await pool.query(
      'SELECT id, username, role, display_name, created_at FROM users WHERE id = $1', [id]
    );
    return fixDates(rows[0] || null);
  },

  async findByUsername(username) {
    const { rows } = await pool.query(
      'SELECT * FROM users WHERE username = $1', [username]
    );
    return rows[0];
  },

  async authenticate(username, password) {
    const { rows } = await pool.query(
      'SELECT * FROM users WHERE username = $1', [username]
    );
    const user = rows[0];
    if (!user) return null;
    if (!verifyPassword(password, user.password_hash)) return null;
    return { id: user.id, username: user.username, role: user.role, display_name: user.display_name };
  },

  async create(data) {
    const { rows } = await pool.query(
      'INSERT INTO users (username, password_hash, role, display_name) VALUES ($1, $2, $3, $4) RETURNING id',
      [data.username, hashPassword(data.password), data.role || 'viewer', data.display_name || data.username]
    );
    return rows[0].id;
  },

  async update(id, data) {
    if (data.password && data.password.trim()) {
      await pool.query(
        'UPDATE users SET username=$1, role=$2, display_name=$3, password_hash=$4 WHERE id=$5',
        [data.username, data.role, data.display_name || data.username, hashPassword(data.password), id]
      );
    } else {
      await pool.query(
        'UPDATE users SET username=$1, role=$2, display_name=$3 WHERE id=$4',
        [data.username, data.role, data.display_name || data.username, id]
      );
    }
  },

  async delete(id) {
    const result = await pool.query('DELETE FROM users WHERE id = $1', [id]);
    return result;
  }
};

module.exports = User;
