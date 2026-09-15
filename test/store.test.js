const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { FuelStore, validateEntry, validateMaintenance, validateVehicle } = require('../src/store');

async function makeStore(prefix = 'gascost-') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const store = new FuelStore(path.join(directory, 'gascost.db'), path.join(directory, 'fuel.json'));
  await store.init();
  return { store, directory, vehicle: store.listVehicles()[0] };
}

test('valida e normaliza um abastecimento completo', () => {
  const result = validateEntry({ vehicleId: 'vehicle-1', date: '2026-09-08', fuelType: 'Gasolina', liters: '42.5678', amount: '250.129', odometer: '50000', fullTank: true });
  assert.equal(result.liters, 42.568);
  assert.equal(result.amount, 250.13);
  assert.equal(result.odometer, 50000);
  assert.equal(result.fullTank, true);
});

test('rejeita veículo ausente e valores inválidos', () => {
  assert.throws(() => validateEntry({ date: '2026-09-08', fuelType: 'Etanol', liters: 10, amount: 40 }), /veículo/i);
  assert.throws(() => validateEntry({ vehicleId: 'v', date: '2026-09-08', fuelType: 'Etanol', liters: 0, amount: 10 }), /quantidade/i);
  assert.throws(() => validateVehicle({ name: '', fuelType: 'Gasolina' }), /nome/i);
  assert.throws(() => validateMaintenance({ vehicleId: 'v', category: 'Inválida', description: 'Teste', date: '2026-09-08' }), /categoria/i);
});

test('persiste, edita e remove abastecimentos no SQLite', async () => {
  const { store, directory, vehicle } = await makeStore();
  const created = store.create({ vehicleId: vehicle.id, date: '2026-09-08', fuelType: 'Diesel', liters: 10, amount: 60, odometer: 40000, fullTank: true });
  assert.equal(store.list(vehicle.id).length, 1);
  const updated = store.update(created.id, { vehicleId: vehicle.id, date: '2026-09-07', fuelType: 'Etanol', liters: 25, amount: 100, station: 'Posto Novo', fullTank: false });
  assert.equal(updated.id, created.id);
  assert.equal(updated.createdAt, created.createdAt);
  assert.equal(updated.station, 'Posto Novo');
  assert.equal(updated.fullTank, false);
  store.close();

  const reloaded = new FuelStore(path.join(directory, 'gascost.db'), path.join(directory, 'fuel.json'));
  await reloaded.init();
  assert.equal(reloaded.list()[0].id, created.id);
  assert.equal(reloaded.remove(created.id), true);
  assert.equal(reloaded.list().length, 0);
  reloaded.close();
});

test('gerencia vários veículos e suas manutenções', async () => {
  const { store } = await makeStore('gascost-vehicles-');
  const vehicle = store.createVehicle({ name: 'Civic', make: 'Honda', model: 'Touring', plate: 'abc1d23', fuelType: 'Gasolina' });
  assert.equal(vehicle.plate, 'ABC1D23');
  const changed = store.updateVehicle(vehicle.id, { ...vehicle, name: 'Civic da família' });
  assert.equal(changed.name, 'Civic da família');

  const maintenance = store.createMaintenance({ vehicleId: vehicle.id, category: 'Óleo e filtros', description: 'Troca de óleo', date: '2026-09-08', amount: 320, nextDate: '2027-03-08', nextOdometer: 70000 });
  assert.equal(store.listMaintenance(vehicle.id).length, 1);
  const updated = store.updateMaintenance(maintenance.id, { ...maintenance, description: 'Óleo e filtros trocados', amount: 350 });
  assert.equal(updated.amount, 350);
  assert.equal(store.removeMaintenance(maintenance.id), true);
  assert.equal(store.listMaintenance(vehicle.id).length, 0);
  store.close();
});

test('migra o histórico JSON existente uma única vez', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gascost-migration-'));
  const legacy = path.join(directory, 'fuel.json');
  await fs.writeFile(legacy, JSON.stringify([{ id: 'legacy-id', date: '2026-08-01', fuelType: 'Gasolina', liters: 40, amount: 240, station: 'Antigo', createdAt: '2026-08-01T12:00:00.000Z' }]));
  const store = new FuelStore(path.join(directory, 'gascost.db'), legacy);
  await store.init();
  assert.equal(store.list().length, 1);
  assert.equal(store.list()[0].id, 'legacy-id');
  assert.equal(store.list()[0].fullTank, true);
  store.close();

  const reloaded = new FuelStore(path.join(directory, 'gascost.db'), legacy);
  await reloaded.init();
  assert.equal(reloaded.list().length, 1);
  reloaded.close();
});

test('backup reúne todos os conjuntos de dados', async () => {
  const { store, vehicle } = await makeStore('gascost-backup-');
  store.create({ vehicleId: vehicle.id, date: '2026-09-08', fuelType: 'Gasolina', liters: 20, amount: 120, fullTank: true });
  const backup = store.backup();
  assert.equal(backup.version, 1);
  assert.equal(backup.vehicles.length, 1);
  assert.equal(backup.fuelEntries.length, 1);
  assert.deepEqual(backup.maintenance, []);
  store.close();
});
