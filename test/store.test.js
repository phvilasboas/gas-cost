const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { FuelStore, validateEntry, validateMaintenance, validateVehicle } = require('../src/store');
const USER_ID = 1;

async function makeStore(prefix = 'gascost-') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const store = new FuelStore(path.join(directory, 'gascost.db'), path.join(directory, 'fuel.json'));
  await store.init();
  await store.initializeUser(USER_ID, { claimUnowned: true });
  return { store, directory, vehicle: store.listVehicles(USER_ID)[0] };
}

test('valida e normaliza um abastecimento completo', () => {
  const result = validateEntry({ vehicleId: 'vehicle-1', date: '2026-09-08', time: '17:45', fuelType: 'Gasolina', liters: '42.5678', amount: '250.129', odometer: '50000', fullTank: true });
  assert.equal(result.liters, 42.568);
  assert.equal(result.amount, 250.13);
  assert.equal(result.odometer, 50000);
  assert.equal(result.fullTank, true);
  assert.equal(result.time, '17:45');
});

test('rejeita veículo ausente e valores inválidos', () => {
  assert.throws(() => validateEntry({ date: '2026-09-08', fuelType: 'Etanol', liters: 10, amount: 40 }), /veículo/i);
  assert.throws(() => validateEntry({ vehicleId: 'v', date: '2026-09-08', fuelType: 'Etanol', liters: 0, amount: 10 }), /quantidade/i);
  assert.throws(() => validateVehicle({ name: '', fuelType: 'Gasolina' }), /nome/i);
  assert.throws(() => validateMaintenance({ vehicleId: 'v', category: 'Inválida', description: 'Teste', date: '2026-09-08' }), /categoria/i);
  assert.throws(() => validateEntry({ vehicleId: 'v', date: '2026-09-08', time: '25:70', fuelType: 'Etanol', liters: 10, amount: 40 }), /hora/i);
});

test('persiste, edita e remove abastecimentos no SQLite', async () => {
  const { store, directory, vehicle } = await makeStore();
  const created = store.create(USER_ID, { vehicleId: vehicle.id, date: '2026-09-08', fuelType: 'Diesel', liters: 10, amount: 60, odometer: 40000, fullTank: true });
  assert.equal(store.list(USER_ID, vehicle.id).length, 1);
  const updated = store.update(USER_ID, created.id, { vehicleId: vehicle.id, date: '2026-09-07', time: '08:35', fuelType: 'Etanol', liters: 25, amount: 100, station: 'Posto Novo', fullTank: false });
  assert.equal(updated.id, created.id);
  assert.equal(updated.createdAt, created.createdAt);
  assert.equal(updated.station, 'Posto Novo');
  assert.equal(updated.fullTank, false);
  assert.equal(updated.time, '08:35');
  store.close();

  const reloaded = new FuelStore(path.join(directory, 'gascost.db'), path.join(directory, 'fuel.json'));
  await reloaded.init();
  await reloaded.initializeUser(USER_ID, { claimUnowned: true });
  assert.equal(reloaded.list(USER_ID)[0].id, created.id);
  assert.equal(reloaded.remove(USER_ID, created.id), true);
  assert.equal(reloaded.list(USER_ID).length, 0);
  reloaded.close();
});

test('gerencia vários veículos e suas manutenções', async () => {
  const { store } = await makeStore('gascost-vehicles-');
  const vehicle = store.createVehicle(USER_ID, { name: 'Civic', make: 'Honda', model: 'Touring', plate: 'abc1d23', fuelType: 'Gasolina' });
  assert.equal(vehicle.plate, 'ABC1D23');
  const changed = store.updateVehicle(USER_ID, vehicle.id, { ...vehicle, name: 'Civic da família' });
  assert.equal(changed.name, 'Civic da família');

  const maintenance = store.createMaintenance(USER_ID, { vehicleId: vehicle.id, category: 'Óleo e filtros', description: 'Troca de óleo', date: '2026-09-08', amount: 320, nextDate: '2027-03-08', nextOdometer: 70000 });
  assert.equal(store.listMaintenance(USER_ID, vehicle.id).length, 1);
  const updated = store.updateMaintenance(USER_ID, maintenance.id, { ...maintenance, description: 'Óleo e filtros trocados', amount: 350 });
  assert.equal(updated.amount, 350);
  assert.equal(store.removeMaintenance(USER_ID, maintenance.id), true);
  assert.equal(store.listMaintenance(USER_ID, vehicle.id).length, 0);
  store.close();
});

test('migra o histórico JSON existente uma única vez', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gascost-migration-'));
  const legacy = path.join(directory, 'fuel.json');
  await fs.writeFile(legacy, JSON.stringify([{ id: 'legacy-id', date: '2026-08-01', fuelType: 'Gasolina', liters: 40, amount: 240, station: 'Antigo', createdAt: '2026-08-01T12:00:00.000Z' }]));
  const store = new FuelStore(path.join(directory, 'gascost.db'), legacy);
  await store.init();
  await store.initializeUser(USER_ID, { claimUnowned: true });
  assert.equal(store.list(USER_ID).length, 1);
  assert.equal(store.list(USER_ID)[0].id, 'legacy-id');
  assert.equal(store.list(USER_ID)[0].fullTank, true);
  store.close();

  const reloaded = new FuelStore(path.join(directory, 'gascost.db'), legacy);
  await reloaded.init();
  await reloaded.initializeUser(USER_ID, { claimUnowned: true });
  assert.equal(reloaded.list(USER_ID).length, 1);
  reloaded.close();
});

test('backup reúne todos os conjuntos de dados', async () => {
  const { store, vehicle } = await makeStore('gascost-backup-');
  store.create(USER_ID, { vehicleId: vehicle.id, date: '2026-09-08', fuelType: 'Gasolina', liters: 20, amount: 120, fullTank: true });
  const backup = store.backup(USER_ID);
  assert.equal(backup.version, 2);
  assert.equal(backup.vehicles.length, 1);
  assert.equal(backup.fuelEntries.length, 1);
  assert.deepEqual(backup.maintenance, []);
  store.close();
});

test('lista abastecimentos por data e hora, mesmo quando cadastrados fora de ordem', async () => {
  const { store, vehicle } = await makeStore('gascost-order-');
  const base = { vehicleId: vehicle.id, date: '2026-09-20', fuelType: 'Gasolina', liters: 10, amount: 60, fullTank: false };
  store.create(USER_ID, { ...base, time: '18:30', station: 'Último' });
  store.create(USER_ID, { ...base, time: '08:15', station: 'Primeiro' });
  store.create(USER_ID, { ...base, time: '12:00', station: 'Meio' });

  assert.deepEqual(store.list(USER_ID, vehicle.id).map((item) => item.station), ['Último', 'Meio', 'Primeiro']);
  store.close();
});

test('adiciona a coluna de hora em bancos criados por versões anteriores', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gascost-schema-'));
  const dbPath = path.join(directory, 'gascost.db');
  const oldDatabase = new DatabaseSync(dbPath);
  oldDatabase.exec(`CREATE TABLE fuel_entries (
    id TEXT PRIMARY KEY, vehicle_id TEXT NOT NULL, date TEXT NOT NULL,
    fuel_type TEXT NOT NULL, liters REAL NOT NULL, amount REAL NOT NULL,
    station TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', odometer REAL,
    full_tank INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT
  )`);
  oldDatabase.close();

  const store = new FuelStore(dbPath, path.join(directory, 'fuel.json'));
  await store.init();
  await store.initializeUser(USER_ID, { claimUnowned: true });
  const columns = store.db.prepare('PRAGMA table_info(fuel_entries)').all().map((column) => column.name);
  assert.ok(columns.includes('time'));
  const vehicle = store.listVehicles(USER_ID)[0];
  const created = store.create(USER_ID, { vehicleId: vehicle.id, date: '2026-09-20', time: '07:10', fuelType: 'Gasolina', liters: 20, amount: 120, fullTank: true });
  assert.equal(created.time, '07:10');
  store.close();
});

test('isola veículos e registros por usuário', async () => {
  const { store, vehicle: firstVehicle } = await makeStore('gascost-users-');
  const secondUserId = 2;
  const secondVehicle = await store.initializeUser(secondUserId);
  store.create(USER_ID, { vehicleId: firstVehicle.id, date: '2026-09-20', fuelType: 'Gasolina', liters: 10, amount: 60, fullTank: true });
  store.create(secondUserId, { vehicleId: secondVehicle.id, date: '2026-09-21', fuelType: 'Etanol', liters: 20, amount: 80, fullTank: true });

  assert.equal(store.listVehicles(USER_ID).length, 1);
  assert.equal(store.listVehicles(secondUserId).length, 1);
  assert.equal(store.list(USER_ID).length, 1);
  assert.equal(store.list(secondUserId).length, 1);
  assert.equal(store.getVehicle(USER_ID, secondVehicle.id), null);
  assert.throws(() => store.create(USER_ID, { vehicleId: secondVehicle.id, date: '2026-09-22', fuelType: 'Gasolina', liters: 5, amount: 30 }), /não encontrado/i);
  store.close();
});

test('atribui dados de versões anteriores ao primeiro usuário', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gascost-owner-migration-'));
  const dbPath = path.join(directory, 'gascost.db');
  const oldDatabase = new DatabaseSync(dbPath);
  oldDatabase.exec(`
    CREATE TABLE vehicles (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, make TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '',
      plate TEXT NOT NULL DEFAULT '', fuel_type TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT
    );
    CREATE TABLE fuel_entries (
      id TEXT PRIMARY KEY, vehicle_id TEXT NOT NULL REFERENCES vehicles(id), date TEXT NOT NULL,
      fuel_type TEXT NOT NULL, liters REAL NOT NULL, amount REAL NOT NULL, station TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '', odometer REAL, full_tank INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, updated_at TEXT
    );
    INSERT INTO vehicles (id, name, fuel_type, created_at) VALUES ('old-car', 'Carro antigo', 'Gasolina', '2026-01-01T00:00:00.000Z');
    INSERT INTO fuel_entries (id, vehicle_id, date, fuel_type, liters, amount, created_at)
      VALUES ('old-entry', 'old-car', '2026-01-02', 'Gasolina', 10, 60, '2026-01-02T00:00:00.000Z');
  `);
  oldDatabase.close();

  const store = new FuelStore(dbPath);
  await store.init();
  await store.initializeUser(USER_ID, { claimUnowned: true });
  await store.initializeUser(2);
  assert.equal(store.listVehicles(USER_ID)[0].id, 'old-car');
  assert.equal(store.list(USER_ID)[0].id, 'old-entry');
  assert.equal(store.list(2).length, 0);
  store.close();
});
