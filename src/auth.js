const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
const SCRYPT_OPTIONS = { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
const MCP_SCOPES = ['gascost:fuel:read', 'gascost:maintenance:read'];

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
        role TEXT NOT NULL DEFAULT 'user',
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
      CREATE TABLE IF NOT EXISTS mcp_tokens (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        scopes TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
        revoked_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_mcp_tokens_user ON mcp_tokens(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_mcp_tokens_hash ON mcp_tokens(token_hash);
    `);
    const userColumns = this.db.prepare('PRAGMA table_info(users)').all();
    if (!userColumns.some((column) => column.name === 'role')) {
      this.db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'");
    }
    if (!this.db.prepare("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1").get()) {
      this.db.prepare("UPDATE users SET role = 'admin' WHERE id = (SELECT id FROM users ORDER BY created_at, id LIMIT 1)").run();
    }
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
      const id = this.db.prepare("INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, 'admin', ?)")
        .run(values.username, passwordHash, Date.now()).lastInsertRowid;
      this.db.exec('COMMIT');
      return id;
    } catch (error) {
      this.db.exec('ROLLBACK');
      if (error.code === 'ERR_SQLITE_CONSTRAINT_UNIQUE') throw new Error('Este usuário já existe.');
      throw error;
    }
  }

  async createUser(username, password) {
    const values = validateCredentials(username, password);
    const passwordHash = await hashPassword(values.password);
    try {
      const id = this.db.prepare("INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, 'user', ?)")
        .run(values.username, passwordHash, Date.now()).lastInsertRowid;
      return this.getUser(Number(id));
    } catch (error) {
      if (error.code === 'ERR_SQLITE_CONSTRAINT_UNIQUE') throw new Error('Este usuário já existe.');
      throw error;
    }
  }

  getUser(userId) {
    const row = this.db.prepare('SELECT id, username, role, created_at FROM users WHERE id = ?').get(userId);
    return row ? { id: Number(row.id), username: row.username, role: row.role, createdAt: row.created_at } : null;
  }

  getFirstUser() {
    const row = this.db.prepare('SELECT id, username, role, created_at FROM users ORDER BY created_at, id LIMIT 1').get();
    return row ? { id: Number(row.id), username: row.username, role: row.role, createdAt: row.created_at } : null;
  }

  listUsers() {
    return this.db.prepare('SELECT id, username, role, created_at FROM users ORDER BY created_at, id').all()
      .map((row) => ({ id: Number(row.id), username: row.username, role: row.role, createdAt: row.created_at }));
  }

  async authenticate(username, password) {
    const normalized = normalizeUsername(username);
    const user = this.db.prepare('SELECT id, username, role, password_hash FROM users WHERE username = ?').get(normalized);
    const passwordValue = String(password || '');
    const encoded = user ? user.password_hash : await this.dummyHashPromise;
    if (!await verifyPassword(passwordValue, encoded) || !user) return null;
    if (user.password_hash.startsWith('scrypt$16384$')) {
      const upgraded = await hashPassword(passwordValue);
      this.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(upgraded, user.id);
    }
    return { id: Number(user.id), username: user.username, role: user.role };
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
    const row = this.db.prepare(`SELECT users.id, users.username, users.role FROM sessions
      JOIN users ON users.id = sessions.user_id
      WHERE sessions.token_hash = ? AND sessions.expires_at > ?`).get(this.tokenHash(token), now);
    return row ? { id: Number(row.id), username: row.username, role: row.role } : null;
  }

  deleteSession(token) {
    if (token) this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(this.tokenHash(token));
  }

  async changePassword(userId, currentPassword, newPassword) {
    const user = this.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId);
    if (!user || !await verifyPassword(String(currentPassword || ''), user.password_hash)) {
      throw new Error('A senha atual está incorreta.');
    }
    if (typeof newPassword !== 'string' || newPassword.length < 12 || newPassword.length > 128) {
      throw new Error('A nova senha deve ter entre 12 e 128 caracteres.');
    }
    const passwordHash = await hashPassword(newPassword);
    this.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, userId);
    this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }

  normalizeMcpScopes(scopes) {
    const values = [...new Set(Array.isArray(scopes) ? scopes.map(String) : [])];
    if (!values.length || values.some((scope) => !MCP_SCOPES.includes(scope))) {
      throw new Error('Selecione ao menos uma permissão MCP válida.');
    }
    return values;
  }

  createMcpToken(userId, input = {}) {
    if (!this.getUser(userId)) throw new Error('Usuário não encontrado.');
    const name = String(input.name || '').trim().slice(0, 60);
    if (name.length < 2) throw new Error('Informe um nome para identificar o acesso.');
    const scopes = this.normalizeMcpScopes(input.scopes);
    const expiresInDays = Number(input.expiresInDays ?? 90);
    if (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 365) {
      throw new Error('A validade deve ficar entre 1 e 365 dias.');
    }
    const id = crypto.randomUUID();
    const token = `gct_${crypto.randomBytes(32).toString('base64url')}`;
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + expiresInDays * 24 * 60 * 60;
    this.db.prepare(`INSERT INTO mcp_tokens
      (id, user_id, name, token_hash, scopes, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, userId, name, this.tokenHash(token), JSON.stringify(scopes), expiresAt, now);
    return { id, name, token, scopes, expiresAt, createdAt: now, lastUsedAt: null };
  }

  listMcpTokens(userId) {
    return this.db.prepare(`SELECT id, name, scopes, expires_at, created_at, last_used_at
      FROM mcp_tokens WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC`).all(userId)
      .map((row) => ({
        id: row.id,
        name: row.name,
        scopes: JSON.parse(row.scopes),
        expiresAt: row.expires_at,
        createdAt: row.created_at,
        lastUsedAt: row.last_used_at,
      }));
  }

  revokeMcpToken(userId, tokenId) {
    return this.db.prepare(`UPDATE mcp_tokens SET revoked_at = ?
      WHERE id = ? AND user_id = ? AND revoked_at IS NULL`)
      .run(Math.floor(Date.now() / 1000), tokenId, userId).changes > 0;
  }

  verifyMcpToken(token) {
    if (typeof token !== 'string' || !token.startsWith('gct_') || token.length < 40) return null;
    const now = Math.floor(Date.now() / 1000);
    const row = this.db.prepare(`SELECT m.id, m.user_id, m.name, m.scopes, m.expires_at,
        u.username, u.role
      FROM mcp_tokens m JOIN users u ON u.id = m.user_id
      WHERE m.token_hash = ? AND m.revoked_at IS NULL AND m.expires_at > ?`)
      .get(this.tokenHash(token), now);
    if (!row) return null;
    this.db.prepare('UPDATE mcp_tokens SET last_used_at = ? WHERE id = ?').run(now, row.id);
    return {
      id: row.id,
      userId: Number(row.user_id),
      username: row.username,
      role: row.role,
      name: row.name,
      scopes: JSON.parse(row.scopes),
      expiresAt: row.expires_at,
    };
  }

  tokenHash(token) { return crypto.createHash('sha256').update(token).digest('hex'); }
  close() { this.db.close(); }
}

module.exports = { AuthStore, hashPassword, verifyPassword, validateCredentials, SESSION_TTL_SECONDS, MCP_SCOPES };
