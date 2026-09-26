const crypto = require('node:crypto');
const { MCP_SCOPES } = require('./auth');

const now = () => Math.floor(Date.now() / 1000);
const secret = () => crypto.randomBytes(32).toString('base64url');
const hash = (value) => crypto.createHash('sha256').update(String(value)).digest('base64url');
const SCOPES = [...MCP_SCOPES, 'offline_access'];
function fail(code, message) { throw Object.assign(new Error(message), { oauthCode: code }); }

class OAuthStore {
  constructor(auth, origin) {
    this.auth = auth;
    this.db = auth.db;
    this.origin = new URL(origin).origin;
    this.resource = `${this.origin}/mcp`;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS oauth_clients (id TEXT PRIMARY KEY, redirects TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS oauth_pending (id TEXT PRIMARY KEY, session_hash TEXT NOT NULL, params TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS oauth_grants (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), client_id TEXT NOT NULL,
        scopes TEXT NOT NULL, resource TEXT NOT NULL, expires INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS oauth_codes (hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES oauth_grants(id),
        redirect TEXT NOT NULL, challenge TEXT NOT NULL, expires INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS oauth_tokens (hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES oauth_grants(id),
        kind TEXT NOT NULL, expires INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS oauth_tokens_grant ON oauth_tokens(grant_id);
    `);
  }

  metadata() {
    return { issuer: this.origin, authorization_endpoint: `${this.origin}/oauth/authorize`, token_endpoint: `${this.origin}/oauth/token`,
      registration_endpoint: `${this.origin}/oauth/register`, revocation_endpoint: `${this.origin}/oauth/revoke`,
      response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'], revocation_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'], scopes_supported: SCOPES, authorization_response_iss_parameter_supported: true };
  }

  protectedResource() {
    return { resource: this.resource, authorization_servers: [this.origin], scopes_supported: SCOPES,
      bearer_methods_supported: ['header'], resource_name: 'GasCost' };
  }

  register(input) {
    const redirects = input.redirect_uris;
    if (!Array.isArray(redirects) || !redirects.length || redirects.length > 5) fail('invalid_client_metadata', 'Informe os endereços de retorno.');
    for (const value of redirects) {
      let url;
      try { url = new URL(value); } catch { fail('invalid_redirect_uri', 'Retorno inválido.'); }
      // Registration is deliberately restricted to ChatGPT callbacks. No arbitrary URLs or network fetches.
      if (url.origin !== 'https://chatgpt.com' || url.search || url.hash || url.username || url.password ||
          !(url.pathname === '/connector_platform_oauth_redirect' || /^\/connector\/oauth\/[A-Za-z0-9_-]+$/.test(url.pathname))) {
        fail('invalid_redirect_uri', 'Somente retornos oficiais do ChatGPT são permitidos.');
      }
    }
    if (input.token_endpoint_auth_method && input.token_endpoint_auth_method !== 'none') fail('invalid_client_metadata', 'Use cliente público com PKCE.');
    if (input.grant_types?.some((value) => !['authorization_code', 'refresh_token'].includes(value)) ||
        input.response_types?.some((value) => value !== 'code')) fail('invalid_client_metadata', 'Fluxo não suportado.');
    const encoded = JSON.stringify([...new Set(redirects)].sort());
    const existing = this.db.prepare('SELECT id FROM oauth_clients WHERE redirects = ?').get(encoded);
    const id = existing?.id || crypto.randomUUID();
    if (!existing) this.db.prepare('INSERT INTO oauth_clients VALUES (?, ?)').run(id, encoded);
    return { client_id: id, client_name: 'ChatGPT', redirect_uris: JSON.parse(encoded), token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] };
  }

  validate(params) {
    const client = this.db.prepare('SELECT * FROM oauth_clients WHERE id = ?').get(String(params.client_id || ''));
    if (!client || !JSON.parse(client.redirects).includes(params.redirect_uri)) fail('invalid_request', 'Cliente ou retorno inválido.');
    if (params.response_type !== 'code' || params.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(params.code_challenge || '')) {
      fail('invalid_request', 'Authorization Code com PKCE S256 é obrigatório.');
    }
    if (params.resource !== this.resource) fail('invalid_target', 'Recurso inválido.');
    const scopes = [...new Set(String(params.scope || MCP_SCOPES.join(' ')).split(' ').filter(Boolean))];
    if (scopes.some((scope) => !SCOPES.includes(scope)) || !scopes.some((scope) => MCP_SCOPES.includes(scope))) fail('invalid_scope', 'Permissões inválidas.');
    if (String(params.state || '').length > 2048) fail('invalid_request', 'State inválido.');
    return { client_id: client.id, redirect_uri: params.redirect_uri, code_challenge: params.code_challenge,
      resource: this.resource, scope: scopes.join(' '), state: params.state || '' };
  }

  prepare(params, session) {
    const validated = this.validate(params);
    const csrf = secret();
    this.db.prepare('DELETE FROM oauth_pending WHERE expires <= ?').run(now());
    this.db.prepare('INSERT INTO oauth_pending VALUES (?, ?, ?, ?)').run(hash(csrf), hash(session), JSON.stringify(validated), now() + 600);
    return { csrf, client: 'ChatGPT', scopes: validated.scope.split(' '), redirect: validated.redirect_uri };
  }

  consent(csrf, session, userId, approved) {
    const pending = this.db.prepare('DELETE FROM oauth_pending WHERE id = ? AND session_hash = ? AND expires > ? RETURNING *')
      .get(hash(csrf), hash(session), now());
    if (!pending) fail('invalid_request', 'Autorização expirada. Reabra a conexão no ChatGPT.');
    const params = JSON.parse(pending.params);
    const redirect = new URL(params.redirect_uri);
    redirect.searchParams.set('state', params.state);
    redirect.searchParams.set('iss', this.origin);
    if (!approved) { redirect.searchParams.set('error', 'access_denied'); return redirect.href; }
    const grantId = crypto.randomUUID();
    const code = secret();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO oauth_grants VALUES (?, ?, ?, ?, ?, ?, 0, ?)')
        .run(grantId, userId, params.client_id, params.scope, params.resource, now() + 90 * 86400, now());
      this.db.prepare('INSERT INTO oauth_codes VALUES (?, ?, ?, ?, ?, 0)')
        .run(hash(code), grantId, params.redirect_uri, params.code_challenge, now() + 120);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    redirect.searchParams.set('code', code);
    return redirect.href;
  }

  grant(id, input) {
    const grant = this.db.prepare('SELECT * FROM oauth_grants WHERE id = ? AND revoked = 0 AND expires > ?').get(id, now());
    if (!grant || grant.client_id !== input.client_id) fail('invalid_grant', 'Credencial inválida.');
    if (input.resource !== grant.resource || input.resource !== this.resource) fail('invalid_target', 'Recurso inválido.');
    return grant;
  }

  issue(grant) {
    const access = `gco_${secret()}`;
    const expires = Math.min(now() + 3600, grant.expires);
    this.db.prepare('INSERT INTO oauth_tokens VALUES (?, ?, ?, ?, 0)').run(hash(access), grant.id, 'access', expires);
    const result = { access_token: access, token_type: 'Bearer', expires_in: expires - now(), scope: grant.scopes };
    if (grant.scopes.split(' ').includes('offline_access')) {
      result.refresh_token = `gcr_${secret()}`;
      this.db.prepare('INSERT INTO oauth_tokens VALUES (?, ?, ?, ?, 0)').run(hash(result.refresh_token), grant.id, 'refresh', grant.expires);
    }
    return result;
  }

  exchange(input) {
    if (input.grant_type === 'authorization_code') {
      const code = this.db.prepare('SELECT * FROM oauth_codes WHERE hash = ?').get(hash(input.code || ''));
      if (!code || code.expires <= now()) fail('invalid_grant', 'Código inválido ou expirado.');
      const grant = this.grant(code.grant_id, input);
      if (input.redirect_uri !== code.redirect || !/^[A-Za-z0-9._~-]{43,128}$/.test(input.code_verifier || '') || hash(input.code_verifier) !== code.challenge) {
        fail('invalid_grant', 'Código ou PKCE inválido.');
      }
      if (code.used) { this.revoke(grant.id); fail('invalid_grant', 'Código já utilizado.'); }
      return this.rotate(() => this.db.prepare('UPDATE oauth_codes SET used = 1 WHERE hash = ?').run(code.hash), grant);
    }
    if (input.grant_type === 'refresh_token') {
      const token = this.db.prepare("SELECT * FROM oauth_tokens WHERE hash = ? AND kind = 'refresh'").get(hash(input.refresh_token || ''));
      if (!token || token.expires <= now()) fail('invalid_grant', 'Renovação inválida ou expirada.');
      const grant = this.grant(token.grant_id, input);
      if (token.used) { this.revoke(grant.id); fail('invalid_grant', 'Renovação reutilizada; conexão revogada.'); }
      if (input.scope && input.scope !== grant.scopes) fail('invalid_scope', 'Renove com as mesmas permissões.');
      return this.rotate(() => this.db.prepare('UPDATE oauth_tokens SET used = 1 WHERE hash = ?').run(token.hash), grant);
    }
    fail('unsupported_grant_type', 'Fluxo não suportado.');
  }

  rotate(consume, grant) {
    this.db.exec('BEGIN IMMEDIATE');
    try { consume(); const result = this.issue(grant); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  verify(token) {
    const row = this.db.prepare(`SELECT g.*, u.username FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id
      JOIN users u ON u.id = g.user_id WHERE t.hash = ? AND t.kind = 'access' AND t.expires > ? AND g.expires > ? AND g.revoked = 0 AND g.resource = ?`)
      .get(hash(token), now(), now(), this.resource);
    return row ? { id: row.id, userId: row.user_id, username: row.username, scopes: row.scopes.split(' ').filter((s) => MCP_SCOPES.includes(s)),
      expiresAt: Math.min(row.expires, this.db.prepare('SELECT expires FROM oauth_tokens WHERE hash = ?').get(hash(token)).expires) } : null;
  }

  revoke(id) { this.db.prepare('UPDATE oauth_grants SET revoked = 1 WHERE id = ?').run(id); }
  revokeToken(input) {
    const row = this.db.prepare('SELECT g.id, g.client_id FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id WHERE t.hash = ?').get(hash(input.token || ''));
    if (row && row.client_id === input.client_id) this.revoke(row.id);
  }
  list(userId) {
    return this.db.prepare(`SELECT id, scopes, created, expires FROM oauth_grants WHERE user_id = ? AND revoked = 0 AND expires > ?
      AND EXISTS (SELECT 1 FROM oauth_tokens WHERE grant_id = oauth_grants.id) ORDER BY created DESC`).all(userId, now());
  }
  revokeOwned(userId, id) { return this.db.prepare('UPDATE oauth_grants SET revoked = 1 WHERE id = ? AND user_id = ?').run(id, userId).changes > 0; }
}

module.exports = { OAuthStore };
