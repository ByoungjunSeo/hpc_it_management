const crypto = require('crypto');
const { getDb } = require('../config/database');

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
  findAll() {
    return getDb().prepare('SELECT id, username, role, display_name, created_at FROM users ORDER BY created_at').all();
  },

  findById(id) {
    return getDb().prepare('SELECT id, username, role, display_name, created_at FROM users WHERE id = ?').get(id);
  },

  findByUsername(username) {
    return getDb().prepare('SELECT * FROM users WHERE username = ?').get(username);
  },

  authenticate(username, password) {
    const user = getDb().prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user) return null;
    if (!verifyPassword(password, user.password_hash)) return null;
    return { id: user.id, username: user.username, role: user.role, display_name: user.display_name };
  },

  create(data) {
    const stmt = getDb().prepare(
      'INSERT INTO users (username, password_hash, role, display_name) VALUES (?, ?, ?, ?)'
    );
    const result = stmt.run(
      data.username,
      hashPassword(data.password),
      data.role || 'viewer',
      data.display_name || data.username
    );
    return result.lastInsertRowid;
  },

  update(id, data) {
    if (data.password && data.password.trim()) {
      getDb().prepare(
        'UPDATE users SET username=?, role=?, display_name=?, password_hash=? WHERE id=?'
      ).run(data.username, data.role, data.display_name || data.username, hashPassword(data.password), id);
    } else {
      getDb().prepare(
        'UPDATE users SET username=?, role=?, display_name=? WHERE id=?'
      ).run(data.username, data.role, data.display_name || data.username, id);
    }
  },

  delete(id) {
    return getDb().prepare('DELETE FROM users WHERE id = ?').run(id);
  },

  ensureAdmin() {
    const admin = getDb().prepare("SELECT id FROM users WHERE username = 'admin'").get();
    if (!admin) {
      this.create({ username: 'admin', password: 'qwe123', role: 'admin', display_name: '관리자' });
    }
  }
};

module.exports = User;
