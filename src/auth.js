const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
const SCRYPT_OPTIONS = { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };

function normalizeUsername(value) {
  return String(value || '').trim().toLowerCase();
}

function validateCredentials(username, password) {
  const normalized = normalizeUsername(username);
  if (!/^[a-z0-9._-]{3,40}$/.test(normalized)) {
    throw new Error('O usuário deve ter entre 3 e 40 caracteres e usar apenas letras, números, ponto, hífen ou sublinhado.');
  }
  if (typeof password !== 'string' || password.length < 12 || password.length > 128) {
    throw new Error('A senha deve ter entre 12 e 128 caracteres.');
  }
  return { username: normalized, password };
}

async function hashPassword(password, salt = crypto.randomBytes(16)) {
  const derived = await scrypt(password, salt, 64, SCRYPT_OPTIONS);
  return `scrypt$131072$${salt.toString('hex')}$${derived.toString('hex')}`;
}

async function verifyPassword(password, encoded) {
  try {
    const [algorithm, cost, saltHex, hashHex] = encoded.split('$');
    if (algorithm !== 'scrypt' || !['16384', '131072'].includes(cost)) return false;
    const expected = Buffer.from(hashHex, 'hex');
    const options = cost === '131072' ? SCRYPT_OPTIONS : { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
    const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length, options);
    return crypto.timingSafeEqual(expected, actual);
  } catch { return false; }
}

class AuthStore {
  constructor(filePath) {
    this.db = new DatabaseSync(filePath);
    this.dummyHashPromise = hashPassword(crypto.randomBytes(32).toString('hex'));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
    `);
  }

  hasUsers() {
    return this.db.prepare('SELECT EXISTS(SELECT 1 FROM users) AS found').get().found === 1;
  }

  async createFirstUser(username, password) {
    const values = validateCredentials(username, password);
    if (this.hasUsers()) throw new Error('A conta inicial já foi configurada.');
    const passwordHash = await hashPassword(values.password);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.hasUsers()) throw new Error('A conta inicial já foi configurada.');
      const id = this.db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)')
        .run(values.username, passwordHash, Date.now()).lastInsertRowid;
      this.db.exec('COMMIT');
      return id;
    } catch (error) {
      this.db.exec('ROLLBACK');
      if (error.code === 'ERR_SQLITE_CONSTRAINT_UNIQUE') throw new Error('Este usuário já existe.');
      throw error;
    }
  }

  async authenticate(username, password) {
    const normalized = normalizeUsername(username);
    const user = this.db.prepare('SELECT id, username, password_hash FROM users WHERE username = ?').get(normalized);
    const passwordValue = String(password || '');
    const encoded = user ? user.password_hash : await this.dummyHashPromise;
    if (!await verifyPassword(passwordValue, encoded) || !user) return null;
    if (user.password_hash.startsWith('scrypt$16384$')) {
      const upgraded = await hashPassword(passwordValue);
      this.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(upgraded, user.id);
    }
    return { id: Number(user.id), username: user.username };
  }

  createSession(userId) {
    const token = crypto.randomBytes(32).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
    this.db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
      .run(this.tokenHash(token), userId, now + SESSION_TTL_SECONDS, now);
    return token;
  }

  getSession(token) {
    if (!token) return null;
    const now = Math.floor(Date.now() / 1000);
    const row = this.db.prepare(`SELECT users.id, users.username FROM sessions
      JOIN users ON users.id = sessions.user_id
      WHERE sessions.token_hash = ? AND sessions.expires_at > ?`).get(this.tokenHash(token), now);
    return row ? { id: Number(row.id), username: row.username } : null;
  }

  deleteSession(token) {
    if (token) this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(this.tokenHash(token));
  }

  tokenHash(token) { return crypto.createHash('sha256').update(token).digest('hex'); }
  close() { this.db.close(); }
}

module.exports = { AuthStore, hashPassword, verifyPassword, validateCredentials, SESSION_TTL_SECONDS };
