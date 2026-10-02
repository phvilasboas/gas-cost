const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { FuelStore } = require('./store');
const { AuthStore, SESSION_TTL_SECONDS } = require('./auth');
const { createMcpEndpoint } = require('./mcp');
const { OAuthStore } = require('./oauth');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'fuel.json');
const AUTH_DB_FILE = process.env.AUTH_DB_FILE || path.join(__dirname, '..', 'data', 'auth.db');
const APP_DB_FILE = process.env.APP_DB_FILE || path.join(__dirname, '..', 'data', 'gascost.db');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN || '';
const EXPECTED_HOST = process.env.EXPECTED_HOST || '';
const APP_TIMEZONE = process.env.APP_TIMEZONE || 'America/Sao_Paulo';
const store = new FuelStore(APP_DB_FILE, DATA_FILE);
let auth;
let mcpEndpoint;
let oauth;
const OAUTH_ORIGIN = PUBLIC_ORIGIN || `http://127.0.0.1:${PORT}`;
const loginAttempts = new Map();
const mcpRequests = new Map();

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

function securityHeaders() {
  const headers = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  };
  if (process.env.COOKIE_SECURE === 'true') headers['Strict-Transport-Security'] = 'max-age=31536000';
  return headers;
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, { ...securityHeaders(), 'Content-Type': MIME_TYPES['.json'], 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map((part) => {
    const index = part.indexOf('=');
    return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1))];
  }));
}

function sessionCookie(token, clear = false) {
  const isSecure = process.env.COOKIE_SECURE === 'true';
  const secure = isSecure ? '; Secure' : '';
  const name = isSecure ? '__Host-gas_session' : 'gas_session';
  const age = clear ? 0 : SESSION_TTL_SECONDS;
  return `${name}=${clear ? '' : encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}${secure}`;
}

function sessionToken(req) {
  const parsed = cookies(req);
  return parsed['__Host-gas_session'] || parsed.gas_session;
}

function currentUser(req) { return auth.getSession(sessionToken(req)); }

function clientIp(req) {
  if (process.env.TRUST_PROXY === 'true') {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.trim()) return forwarded.split(',').at(-1).trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function validateOrigin(req) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) || !PUBLIC_ORIGIN) return true;
  return req.headers.origin === PUBLIC_ORIGIN;
}

function safeEqual(value, expected) {
  const actualBuffer = Buffer.from(String(value || ''));
  const expectedBuffer = Buffer.from(String(expected || ''));
  return actualBuffer.length === expectedBuffer.length && require('node:crypto').timingSafeEqual(actualBuffer, expectedBuffer);
}

function loginAllowed(ip) {
  const now = Date.now();
  if (loginAttempts.size > 10_000) {
    for (const [key, value] of loginAttempts) {
      if (now - value.startedAt > 15 * 60 * 1000) loginAttempts.delete(key);
    }
    if (loginAttempts.size > 10_000) loginAttempts.delete(loginAttempts.keys().next().value);
  }
  const record = loginAttempts.get(ip);
  if (!record || now - record.startedAt > 15 * 60 * 1000) {
    loginAttempts.set(ip, { count: 0, startedAt: now });
    return true;
  }
  return record.count < 10;
}

function recordLoginFailure(ip) {
  const record = loginAttempts.get(ip) || { count: 0, startedAt: Date.now() };
  record.count += 1; loginAttempts.set(ip, record);
}

function mcpRequestAllowed(ip) {
  const now = Date.now();
  if (mcpRequests.size > 10_000) {
    for (const [key, value] of mcpRequests) {
      if (now - value.startedAt > 60_000) mcpRequests.delete(key);
    }
  }
  const record = mcpRequests.get(ip);
  if (!record || now - record.startedAt > 60_000) {
    mcpRequests.set(ip, { count: 1, startedAt: now });
    return true;
  }
  record.count += 1;
  return record.count <= 120;
}

function validateMcpOrigin(req) {
  const origin = req.headers.origin;
  return !origin || !PUBLIC_ORIGIN || origin === PUBLIC_ORIGIN;
}

async function readBody(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 64_000) throw new Error('Requisição muito grande.');
  }
  try { return JSON.parse(body || '{}'); } catch { throw new Error('Dados inválidos.'); }
}

async function readOAuthBody(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 16000) throw new Error('Requisição muito grande.');
  }
  const type = String(req.headers['content-type'] || '').split(';')[0];
  if (type === 'application/json') return JSON.parse(body);
  if (type !== 'application/x-www-form-urlencoded') throw new Error('Formato inválido.');
  const params = new URLSearchParams(body);
  if ([...params.keys()].some((key) => params.getAll(key).length !== 1)) throw new Error('Parâmetro duplicado.');
  return Object.fromEntries(params);
}

async function serveStatic(urlPath, res) {
  const assetAliases = {
    '/assets/styles-v3.css': '/styles.css',
    '/assets/auth-v3.js': '/auth.js',
    '/assets/app-v3.js': '/app.js',
    '/assets/styles-v4.css': '/styles.css',
    '/assets/app-v4.js': '/app.js',
    '/assets/app-v5.js': '/app.js',
    '/assets/calculations-v1.js': '/calculations.js',
    '/assets/app-v6.js': '/app.js',
    '/assets/calculations-v2.js': '/calculations.js',
    '/assets/styles-v5.css': '/styles.css',
    '/assets/app-v7.js': '/app.js',
    '/assets/app-v8.js': '/app.js',
    '/assets/app-v9.js': '/app.js',
    '/assets/styles-v6.css': '/styles.css',
  };
  const requested = urlPath === '/' ? '/index.html' : (assetAliases[urlPath] || urlPath);
  const safePath = path.normalize(requested).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safePath);
  if (!filePath.startsWith(PUBLIC_DIR)) return false;
  try {
    const content = await fs.readFile(filePath);
    const cache = path.extname(filePath) === '.html' ? 'no-store' : 'no-cache';
    res.writeHead(200, { ...securityHeaders(), 'Content-Type': MIME_TYPES[path.extname(filePath)] || 'application/octet-stream', 'Cache-Control': cache });
    res.end(content);
    return true;
  } catch { return false; }
}

async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname === '/health' && req.method === 'GET') return json(res, 200, { status: 'ok' });
    const requestHost = String(req.headers.host || '').split(':')[0].toLowerCase();
    if (EXPECTED_HOST && requestHost !== EXPECTED_HOST) return json(res, 421, { error: 'Destino inválido.' });
    if (req.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') return json(res, 200, oauth.metadata());
    if (req.method === 'GET' && ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'].includes(url.pathname)) return json(res, 200, oauth.protectedResource());
    if (url.pathname.startsWith('/oauth/')) {
      try {
        if (!mcpRequestAllowed(`oauth:${clientIp(req)}`)) return json(res, 429, { error: 'temporarily_unavailable' });
        if (url.pathname === '/oauth/authorize' && req.method === 'GET') {
          if ([...url.searchParams.keys()].some((key) => url.searchParams.getAll(key).length !== 1)) throw new Error('Parâmetro duplicado.');
          oauth.validate(Object.fromEntries(url.searchParams));
          return await serveStatic('/oauth.html', res);
        }
        if (req.method !== 'POST') return json(res, 405, { error: 'invalid_request' }, { Allow: 'POST' });
        if (['/oauth/prepare', '/oauth/consent'].includes(url.pathname)) {
          if (req.headers.origin !== OAUTH_ORIGIN) return json(res, 403, { error: 'invalid_request', error_description: 'Origem inválida.' });
          const user = currentUser(req);
          if (!user) return json(res, 401, { error: 'login_required' });
          const body = await readBody(req);
          if (url.pathname === '/oauth/prepare') return json(res, 200, oauth.prepare(body, sessionToken(req)));
          return json(res, 200, { redirect: oauth.consent(body.csrf, sessionToken(req), user.id, body.approved === true) });
        }
        const body = await readOAuthBody(req);
        if (url.pathname === '/oauth/register') return json(res, 201, oauth.register(body));
        if (req.headers.authorization || body.client_secret) return json(res, 401, { error: 'invalid_client', error_description: 'Cliente público: use client_id e PKCE, sem segredo.' });
        if (url.pathname === '/oauth/token') return json(res, 200, oauth.exchange(body));
        if (url.pathname === '/oauth/revoke') { oauth.revokeToken(body); return json(res, 200, {}); }
        return json(res, 404, { error: 'invalid_request' });
      } catch (error) {
        return json(res, 400, { error: error.oauthCode || 'invalid_request', error_description: error.oauthCode ? error.message : 'Solicitação OAuth inválida.' });
      }
    }
    if (url.pathname === '/mcp' || url.pathname === '/mcp/') {
      if (!mcpEndpoint) return json(res, 503, { error: 'O acesso MCP ainda não foi configurado.' });
      if (!validateMcpOrigin(req)) return json(res, 403, { error: 'Origem da requisição não permitida.' });
      if (!mcpRequestAllowed(clientIp(req))) return json(res, 429, { error: 'Limite de consultas MCP excedido.' });
      await mcpEndpoint.handle(req, res);
      return;
    }
    if (!validateOrigin(req)) return json(res, 403, { error: 'Origem da requisição não permitida.' });
    if (url.pathname === '/api/auth/status' && req.method === 'GET') {
      const user = currentUser(req);
      return json(res, 200, { setupRequired: !auth.hasUsers(), authenticated: Boolean(user), user });
    }
    if (url.pathname === '/api/auth/setup' && req.method === 'POST') {
      const body = await readBody(req);
      if (!process.env.BOOTSTRAP_TOKEN) return json(res, 503, { error: 'O primeiro acesso precisa ser habilitado no servidor.' });
      if (!safeEqual(body.bootstrapToken, process.env.BOOTSTRAP_TOKEN)) return json(res, 403, { error: 'Token de configuração inválido.' });
      const userId = await auth.createFirstUser(body.username, body.password);
      await store.initializeUser(userId, { claimUnowned: true });
      const user = await auth.authenticate(body.username, body.password);
      const token = auth.createSession(userId);
      return json(res, 201, { user }, { 'Set-Cookie': sessionCookie(token) });
    }
    if (url.pathname === '/api/auth/login' && req.method === 'POST') {
      const ip = clientIp(req);
      if (!loginAllowed(ip)) return json(res, 429, { error: 'Muitas tentativas. Aguarde 15 minutos e tente novamente.' });
      const body = await readBody(req);
      const user = await auth.authenticate(body.username, body.password);
      if (!user) { recordLoginFailure(ip); return json(res, 401, { error: 'Usuário ou senha inválidos.' }); }
      loginAttempts.delete(ip);
      await store.initializeUser(user.id);
      const token = auth.createSession(user.id);
      return json(res, 200, { user }, { 'Set-Cookie': sessionCookie(token) });
    }
    if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
      auth.deleteSession(sessionToken(req));
      return json(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', true), 'Clear-Site-Data': '"cache", "cookies", "storage"' });
    }
    const user = currentUser(req);
    if (url.pathname.startsWith('/api/') && !user) return json(res, 401, { error: 'Faça login para continuar.' });
    if (url.pathname === '/api/oauth-connections' && req.method === 'GET') return json(res, 200, oauth.list(user.id));
    const connectionMatch = url.pathname.match(/^\/api\/oauth-connections\/([a-f0-9-]+)$/i);
    if (connectionMatch && req.method === 'DELETE') {
      const revoked = oauth.revokeOwned(user.id, connectionMatch[1]);
      return json(res, revoked ? 200 : 404, revoked ? { ok: true } : { error: 'Conexão não encontrada.' });
    }
    if (url.pathname === '/api/profile/password' && req.method === 'PUT') {
      const body = await readBody(req);
      await auth.changePassword(user.id, body.currentPassword, body.newPassword);
      return json(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', true), 'Clear-Site-Data': '"cache", "cookies", "storage"' });
    }
    if (url.pathname === '/api/mcp-tokens' && req.method === 'GET') return json(res, 200, auth.listMcpTokens(user.id));
    if (url.pathname === '/api/mcp-tokens' && req.method === 'POST') return json(res, 201, auth.createMcpToken(user.id, await readBody(req)));
    const mcpTokenMatch = url.pathname.match(/^\/api\/mcp-tokens\/([a-f0-9-]+)$/i);
    if (mcpTokenMatch && req.method === 'DELETE') {
      const revoked = auth.revokeMcpToken(user.id, mcpTokenMatch[1]);
      return json(res, revoked ? 200 : 404, revoked ? { ok: true } : { error: 'Acesso MCP não encontrado.' });
    }
    if (url.pathname === '/api/users' && req.method === 'GET') {
      if (user.role !== 'admin') return json(res, 403, { error: 'Apenas administradores podem consultar usuários.' });
      return json(res, 200, auth.listUsers());
    }
    if (url.pathname === '/api/users' && req.method === 'POST') {
      if (user.role !== 'admin') return json(res, 403, { error: 'Apenas administradores podem criar usuários.' });
      const body = await readBody(req);
      const created = await auth.createUser(body.username, body.password);
      await store.initializeUser(created.id);
      return json(res, 201, created);
    }
    if (url.pathname === '/api/vehicles' && req.method === 'GET') return json(res, 200, store.listVehicles(user.id));
    if (url.pathname === '/api/vehicles' && req.method === 'POST') return json(res, 201, store.createVehicle(user.id, await readBody(req)));
    const vehicleMatch = url.pathname.match(/^\/api\/vehicles\/([a-f0-9-]+)$/i);
    if (vehicleMatch && req.method === 'PUT') {
      const updated = store.updateVehicle(user.id, vehicleMatch[1], await readBody(req));
      return json(res, updated ? 200 : 404, updated || { error: 'Veículo não encontrado.' });
    }
    if (url.pathname === '/api/entries' && req.method === 'GET') return json(res, 200, store.list(user.id, url.searchParams.get('vehicleId') || ''));
    if (url.pathname === '/api/entries' && req.method === 'POST') {
      const entry = await store.create(user.id, await readBody(req));
      return json(res, 201, entry);
    }
    const match = url.pathname.match(/^\/api\/entries\/([a-f0-9-]+)$/i);
    if (match && req.method === 'PUT') {
      const updated = await store.update(user.id, match[1], await readBody(req));
      return json(res, updated ? 200 : 404, updated || { error: 'Registro não encontrado.' });
    }
    if (match && req.method === 'DELETE') {
      const removed = await store.remove(user.id, match[1]);
      return json(res, removed ? 200 : 404, removed ? { ok: true } : { error: 'Registro não encontrado.' });
    }
    if (url.pathname === '/api/maintenance' && req.method === 'GET') return json(res, 200, store.listMaintenance(user.id, url.searchParams.get('vehicleId') || ''));
    if (url.pathname === '/api/maintenance' && req.method === 'POST') return json(res, 201, store.createMaintenance(user.id, await readBody(req)));
    const maintenanceMatch = url.pathname.match(/^\/api\/maintenance\/([a-f0-9-]+)$/i);
    if (maintenanceMatch && req.method === 'PUT') {
      const updated = store.updateMaintenance(user.id, maintenanceMatch[1], await readBody(req));
      return json(res, updated ? 200 : 404, updated || { error: 'Registro não encontrado.' });
    }
    if (maintenanceMatch && req.method === 'DELETE') {
      const removed = store.removeMaintenance(user.id, maintenanceMatch[1]);
      return json(res, removed ? 200 : 404, removed ? { ok: true } : { error: 'Registro não encontrado.' });
    }
    if (url.pathname === '/api/backup' && req.method === 'GET') return json(res, 200, store.backup(user.id), { 'Content-Disposition': 'attachment; filename="gascost-backup.json"' });
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html') && !user) {
      if (await serveStatic('/auth.html', res)) return;
    }
    if (req.method === 'GET' && await serveStatic(url.pathname, res)) return;
    json(res, 404, { error: 'Página não encontrada.' });
  } catch (error) {
    json(res, 400, { error: error.message || 'Não foi possível concluir a operação.' });
  }
}

store.init().then(async () => {
  auth = new AuthStore(AUTH_DB_FILE);
  oauth = new OAuthStore(auth, OAUTH_ORIGIN);
  const firstUser = auth.getFirstUser();
  if (firstUser) await store.initializeUser(firstUser.id, { claimUnowned: true });
  mcpEndpoint = createMcpEndpoint({ store, authStore: auth, oauth, timeZone: APP_TIMEZONE, secureCookies: process.env.COOKIE_SECURE === 'true' });
  const server = http.createServer(handler);
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 100;
  server.listen(PORT, HOST, () => {
    console.log(`GasCost disponível em http://${HOST}:${server.address().port}`);
  });
}).catch((error) => {
  console.error('Falha ao iniciar:', error);
  process.exit(1);
});
