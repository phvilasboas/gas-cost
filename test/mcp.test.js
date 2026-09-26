const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { Client, StreamableHTTPClientTransport } = require('@modelcontextprotocol/client');
const { FuelStore } = require('../src/store');
const { AuthStore } = require('../src/auth');
const { createMcpEndpoint } = require('../src/mcp');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

test('MCP remoto exige Bearer e expõe somente ferramentas de leitura', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gascost-mcp-'));
  const store = new FuelStore(path.join(directory, 'gascost.db'), path.join(directory, 'fuel.json'));
  await store.init();
  const auth = new AuthStore(path.join(directory, 'auth.db'));
  const userId = Number(await auth.createFirstUser('pedro', 'frase de senha muito segura'));
  const other = await auth.createUser('maria', 'outra frase de senha segura');
  const vehicle = await store.initializeUser(userId, { claimUnowned: true });
  const otherVehicle = await store.initializeUser(other.id);
  store.create(userId, { vehicleId: vehicle.id, date: '2026-09-01', time: '08:00', fuelType: 'Gasolina', liters: 40, amount: 240, odometer: 1000, fullTank: true });
  store.create(userId, { vehicleId: vehicle.id, date: '2026-09-05', time: '12:00', fuelType: 'Gasolina', liters: 20, amount: 120, odometer: 1200, fullTank: false, station: 'Posto Teste' });
  store.create(userId, { vehicleId: vehicle.id, date: '2026-09-10', time: '18:00', fuelType: 'Gasolina', liters: 30, amount: 180, odometer: 1500, fullTank: true, station: 'Posto Teste' });
  store.create(other.id, { vehicleId: otherVehicle.id, date: '2026-09-11', fuelType: 'Etanol', liters: 10, amount: 40, fullTank: true });
  const personalToken = auth.createMcpToken(userId, {
    name: 'Teste completo', scopes: ['gascost:fuel:read', 'gascost:maintenance:read'], expiresInDays: 90,
  }).token;

  const endpoint = createMcpEndpoint({ store, authStore: auth, secureCookies: false });
  const server = http.createServer((req, res) => { void endpoint.handle(req, res); });
  const port = await listen(server);
  const url = new URL(`http://127.0.0.1:${port}/mcp`);
  let client;
  try {
    const unauthorized = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(unauthorized.status, 401);
    assert.match(unauthorized.headers.get('www-authenticate'), /^Bearer/);

    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: `Bearer ${personalToken}` } },
    });
    client = new Client({ name: 'gascost-test', version: '1.0.0' });
    await client.connect(transport);

    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      'analisar_consumo',
      'analisar_postos',
      'listar_abastecimentos',
      'listar_manutencoes',
      'listar_veiculos',
      'obter_resumo_combustivel',
    ]);
    assert.ok(listed.tools.every((tool) => tool.annotations?.readOnlyHint === true));

    const consumption = await client.callTool({ name: 'analisar_consumo', arguments: { vehicleId: vehicle.id } });
    assert.equal(consumption.isError, undefined);
    assert.equal(consumption.structuredContent.veiculos[0].consumoKmPorLitro, 10);
    assert.equal(consumption.structuredContent.veiculos[0].custoPorKm, 0.6);

    const summary = await client.callTool({ name: 'obter_resumo_combustivel', arguments: { vehicleId: vehicle.id } });
    assert.equal(summary.structuredContent.abastecimentos, 3);
    assert.equal(summary.structuredContent.valor, 540);
    const vehicles = await client.callTool({ name: 'listar_veiculos', arguments: {} });
    assert.equal(vehicles.structuredContent.veiculos.length, 1);
    assert.equal(vehicles.structuredContent.veiculos[0].id, vehicle.id);
  } finally {
    if (client) await client.close();
    await endpoint.close();
    await closeServer(server);
    store.close();
    auth.close();
  }
});

test('limita as ferramentas às permissões do token pessoal', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gascost-mcp-scope-'));
  const store = new FuelStore(path.join(directory, 'gascost.db'));
  const auth = new AuthStore(path.join(directory, 'auth.db'));
  await store.init();
  const userId = Number(await auth.createFirstUser('admin', 'frase de senha muito segura'));
  await store.initializeUser(userId, { claimUnowned: true });
  const token = auth.createMcpToken(userId, { name: 'Só manutenção', scopes: ['gascost:maintenance:read'], expiresInDays: 30 }).token;
  const endpoint = createMcpEndpoint({ store, authStore: auth, secureCookies: false });
  const server = http.createServer((req, res) => { void endpoint.handle(req, res); });
  const port = await listen(server);
  const client = new Client({ name: 'gascost-scope-test', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }));
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), ['listar_manutencoes', 'listar_veiculos']);
  } finally {
    await client.close();
    await endpoint.close();
    await closeServer(server);
    store.close();
    auth.close();
  }
});
