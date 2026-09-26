const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { AuthStore } = require('../src/auth');
const { OAuthStore } = require('../src/oauth');
const { Client, StreamableHTTPClientTransport } = require('@modelcontextprotocol/client');
const ORIGIN = 'https://gascost.vilasboas.it';
const CALLBACK = 'https://chatgpt.com/connector_platform_oauth_redirect';
const verifier = 'x'.repeat(64);
const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');

function requestParams(client) {
  return { client_id: client.client_id, redirect_uri: CALLBACK, response_type: 'code', resource: `${ORIGIN}/mcp`,
    code_challenge: challenge, code_challenge_method: 'S256', scope: 'gascost:fuel:read offline_access', state: 'test-state' };
}

test('OAuth vincula código, PKCE, recurso, usuário e renovação; detecta reutilização', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gascost-oauth-'));
  const auth = new AuthStore(path.join(directory, 'auth.db'));
  try {
    const userId = Number(await auth.createFirstUser('pedro', 'senha de teste bastante longa'));
    const oauth = new OAuthStore(auth, ORIGIN);
    const client = oauth.register({ redirect_uris: [CALLBACK] });
    assert.throws(() => oauth.register({ redirect_uris: ['https://chatgpt.com.evil.test/connector_platform_oauth_redirect'] }));
    assert.throws(() => oauth.register({ redirect_uris: [`${CALLBACK}?next=https://evil.test`] }));
    const params = requestParams(client);
    assert.throws(() => oauth.validate({ ...params, code_challenge_method: 'plain' }));
    assert.throws(() => oauth.validate({ ...params, scope: 'admin' }));
    assert.throws(() => oauth.validate({ ...params, resource: 'https://evil.test/mcp' }));
    const pending = oauth.prepare(params, 'session-one');
    assert.throws(() => oauth.consent(pending.csrf, 'session-two', userId, true));
    const redirect = new URL(oauth.consent(pending.csrf, 'session-one', userId, true));
    assert.equal(redirect.searchParams.get('state'), 'test-state');
    assert.equal(redirect.searchParams.get('iss'), ORIGIN);
    assert.throws(() => oauth.consent(pending.csrf, 'session-one', userId, true));
    const input = { grant_type: 'authorization_code', client_id: client.client_id, redirect_uri: CALLBACK,
      resource: `${ORIGIN}/mcp`, code: redirect.searchParams.get('code'), code_verifier: verifier };
    assert.throws(() => oauth.exchange({ ...input, code_verifier: 'y'.repeat(64) }));
    assert.throws(() => oauth.exchange({ ...input, client_id: 'other' }));
    assert.throws(() => oauth.exchange({ ...input, resource: 'https://evil.test' }));
    const tokens = oauth.exchange(input);
    assert.equal(oauth.verify(tokens.access_token).userId, userId);
    assert.deepEqual(oauth.verify(tokens.access_token).scopes, ['gascost:fuel:read']);
    assert.ok(tokens.refresh_token);
    const refresh = { grant_type: 'refresh_token', client_id: client.client_id, resource: `${ORIGIN}/mcp`, refresh_token: tokens.refresh_token };
    const renewed = oauth.exchange(refresh);
    assert.notEqual(renewed.refresh_token, tokens.refresh_token);
    assert.ok(oauth.verify(renewed.access_token));
    assert.throws(() => oauth.exchange(refresh));
    assert.equal(oauth.verify(renewed.access_token), null);
    assert.equal(oauth.verify(tokens.access_token), null);
    const rejected = oauth.prepare(params, 'session-one');
    assert.equal(new URL(oauth.consent(rejected.csrf, 'session-one', userId, false)).searchParams.get('error'), 'access_denied');
    const next = oauth.prepare(params, 'session-one');
    input.code = new URL(oauth.consent(next.csrf, 'session-one', userId, true)).searchParams.get('code');
    const nextTokens = oauth.exchange(input);
    assert.throws(() => oauth.exchange(input));
    assert.equal(oauth.verify(nextTokens.access_token), null);
    const expiring = oauth.prepare(params, 'session-one');
    input.code = new URL(oauth.consent(expiring.csrf, 'session-one', userId, true)).searchParams.get('code');
    auth.db.prepare('UPDATE oauth_codes SET expires = 0 WHERE hash = ?').run(crypto.createHash('sha256').update(input.code).digest('base64url'));
    assert.throws(() => oauth.exchange(input));
    const finalConsent = oauth.prepare(params, 'session-one');
    input.code = new URL(oauth.consent(finalConsent.csrf, 'session-one', userId, true)).searchParams.get('code');
    const finalTokens = oauth.exchange(input);
    const reloaded = new OAuthStore(auth, ORIGIN);
    assert.ok(reloaded.verify(finalTokens.access_token));
    assert.equal(new OAuthStore(auth, 'https://other.example').verify(finalTokens.access_token), null);
    auth.db.prepare("UPDATE oauth_tokens SET expires = 0 WHERE kind = 'access'").run();
    assert.equal(oauth.verify(finalTokens.access_token), null);
  } finally { auth.close(); }
});

test('fluxo HTTP: descoberta, login, consentimento, MCP isolado e revogação por proprietário', { timeout: 30000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gascost-oauth-http-'));
  const child = spawn(process.execPath, ['src/server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env,
    PORT: '0', HOST: '127.0.0.1', PUBLIC_ORIGIN: ORIGIN, EXPECTED_HOST: '', COOKIE_SECURE: 'false',
    BOOTSTRAP_TOKEN: 'test-bootstrap', AUTH_DB_FILE: path.join(directory, 'auth.db'), APP_DB_FILE: path.join(directory, 'app.db'), DATA_FILE: path.join(directory, 'fuel.json') }, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  let client;
  try {
    const base = await new Promise((resolve, reject) => {
      let output = '';
      child.stdout.on('data', (data) => { output += data; const match = output.match(/http:\/\/127\.0\.0\.1:\d+/); if (match) resolve(match[0]); });
      child.once('error', reject); child.once('exit', () => reject(new Error('Servidor encerrou antes de iniciar.')));
    });
    const call = (route, body, cookie, origin = ORIGIN) => fetch(`${base}${route}`, { method: body ? 'POST' : 'GET', headers: {
      ...(body ? { 'Content-Type': 'application/json', Origin: origin } : {}), ...(cookie ? { Cookie: cookie } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const setup = await call('/api/auth/setup', { bootstrapToken: 'test-bootstrap', username: 'admin', password: 'senha teste administrador' });
    assert.equal(setup.status, 201);
    const adminCookie = setup.headers.get('set-cookie').split(';')[0];
    await call('/api/users', { username: 'maria', password: 'senha teste outra pessoa' }, adminCookie);
    const login = await call('/api/auth/login', { username: 'maria', password: 'senha teste outra pessoa' });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const myVehicles = await (await call('/api/vehicles', null, cookie)).json();
    const adminVehicles = await (await call('/api/vehicles', null, adminCookie)).json();
    const metadata = await (await call('/.well-known/oauth-authorization-server')).json();
    assert.equal(metadata.issuer, ORIGIN);
    assert.deepEqual(metadata.code_challenge_methods_supported, ['S256']);
    const unauthorized = await call('/mcp', {});
    assert.equal(unauthorized.status, 401);
    assert.match(unauthorized.headers.get('www-authenticate'), /resource_metadata=/);
    const registration = await (await call('/oauth/register', { redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none' })).json();
    const params = requestParams(registration);
    const authorizationPage = await fetch(`${base}/oauth/authorize?${new URLSearchParams(params)}`);
    assert.equal(authorizationPage.status, 200);
    assert.equal(authorizationPage.headers.get('cache-control'), 'no-store');
    assert.match(await authorizationPage.text(), /Conectar ao ChatGPT/);
    assert.equal((await call('/oauth/prepare', params)).status, 401);
    assert.equal((await call('/oauth/prepare', params, cookie, 'https://evil.test')).status, 403);
    const prepared = await (await call('/oauth/prepare', params, cookie)).json();
    const consent = await (await call('/oauth/consent', { csrf: prepared.csrf, approved: true }, cookie)).json();
    const tokenResponse = await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({
      grant_type: 'authorization_code', client_id: registration.client_id, code: new URL(consent.redirect).searchParams.get('code'), code_verifier: verifier,
      redirect_uri: CALLBACK, resource: `${ORIGIN}/mcp` }) });
    assert.equal(tokenResponse.status, 200);
    const tokens = await tokenResponse.json();
    client = new Client({ name: 'oauth-test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } } }));
    const vehicles = await client.callTool({ name: 'listar_veiculos', arguments: {} });
    assert.equal(vehicles.structuredContent.veiculos[0].id, myVehicles[0].id);
    const denied = await client.callTool({ name: 'listar_abastecimentos', arguments: { vehicleId: adminVehicles[0].id } });
    assert.equal(denied.isError, true);
    assert.ok(!(await client.listTools()).tools.some((tool) => tool.name === 'listar_manutencoes'));
    const connections = await (await call('/api/oauth-connections', null, cookie)).json();
    assert.equal(connections.length, 1);
    const revoke = (session) => fetch(`${base}/api/oauth-connections/${connections[0].id}`, { method: 'DELETE', headers: { Origin: ORIGIN, Cookie: session } });
    assert.equal((await revoke(adminCookie)).status, 404);
    assert.equal((await revoke(cookie)).status, 200);
    const rejected = await fetch(`${base}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${tokens.access_token}`, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(rejected.status, 401);
  } finally { if (client) await client.close(); child.kill(); await exited; }
});
