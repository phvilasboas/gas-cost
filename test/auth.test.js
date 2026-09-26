const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { AuthStore, hashPassword, verifyPassword, validateCredentials, MCP_SCOPES } = require('../src/auth');

test('gera hash scrypt com salt e valida a senha', async () => {
  const first = await hashPassword('uma senha longa e segura');
  const second = await hashPassword('uma senha longa e segura');
  assert.notEqual(first, second);
  assert.equal(await verifyPassword('uma senha longa e segura', first), true);
  assert.equal(await verifyPassword('senha incorreta', first), false);
});

test('exige senha com pelo menos 12 caracteres', () => {
  assert.throws(() => validateCredentials('pedro', 'curta'), /12/);
});

test('cria usuário e controla sessões no SQLite', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gas-auth-'));
  const store = new AuthStore(path.join(directory, 'auth.db'));
  assert.equal(store.hasUsers(), false);
  const id = await store.createFirstUser('Pedro', 'frase de senha muito segura');
  assert.equal(store.hasUsers(), true);
  const user = await store.authenticate('pedro', 'frase de senha muito segura');
  assert.equal(user.id, Number(id));
  assert.equal(user.role, 'admin');
  const token = store.createSession(user.id);
  assert.equal(store.getSession(token).username, 'pedro');
  store.deleteSession(token);
  assert.equal(store.getSession(token), null);
  await assert.rejects(() => store.createFirstUser('outro', 'outra senha bastante segura'), /configurada/);
  store.close();
});

test('cria tokens MCP pessoais, guarda somente o hash e permite revogação', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gas-mcp-auth-'));
  const store = new AuthStore(path.join(directory, 'auth.db'));
  const userId = Number(await store.createFirstUser('admin', 'frase de senha muito segura'));
  const created = store.createMcpToken(userId, { name: 'Assistente', scopes: MCP_SCOPES, expiresInDays: 90 });

  assert.match(created.token, /^gct_/);
  assert.equal(store.db.prepare('SELECT token_hash FROM mcp_tokens WHERE id = ?').get(created.id).token_hash.includes(created.token), false);
  const access = store.verifyMcpToken(created.token);
  assert.equal(access.userId, userId);
  assert.deepEqual(access.scopes, MCP_SCOPES);
  assert.equal(store.listMcpTokens(userId)[0].lastUsedAt !== null, true);
  assert.equal(store.revokeMcpToken(userId, created.id), true);
  assert.equal(store.verifyMcpToken(created.token), null);
  store.close();
});
