const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const FUEL_TYPES = ['Gasolina', 'Etanol', 'Diesel', 'GNV', 'Outro'];
const MAINTENANCE_CATEGORIES = ['Óleo e filtros', 'Pneus', 'Freios', 'Revisão', 'Seguro', 'Impostos', 'Lavagem', 'Estacionamento', 'Pedágio', 'Outro'];

function validDate(value, required = true) {
  const date = String(value || '');
  if (!date && !required) return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T12:00:00`))) throw new Error('Informe uma data válida.');
  return date;
}

function optionalNumber(value, label) {
  if (value === '' || value === null || value === undefined) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 100_000_000) throw new Error(`Informe ${label} válida.`);
  return Math.round(number * 1000) / 1000;
}

function validateEntry(input) {
  const entry = {
    vehicleId: String(input.vehicleId || ''), date: validDate(input.date), fuelType: String(input.fuelType || ''),
    liters: Number(input.liters), amount: Number(input.amount), station: String(input.station || '').trim().slice(0, 80),
    notes: String(input.notes || '').trim().slice(0, 240), odometer: optionalNumber(input.odometer, 'uma quilometragem'),
    fullTank: input.fullTank === true || input.fullTank === 'true' || input.fullTank === 'on' || input.fullTank === 1,
  };
  if (!entry.vehicleId) throw new Error('Selecione um veículo.');
  if (!FUEL_TYPES.includes(entry.fuelType)) throw new Error('Selecione um combustível válido.');
  if (!Number.isFinite(entry.liters) || entry.liters <= 0 || entry.liters > 10000) throw new Error('A quantidade deve ser maior que zero.');
  if (!Number.isFinite(entry.amount) || entry.amount <= 0 || entry.amount > 1000000) throw new Error('O valor deve ser maior que zero.');
  entry.liters = Math.round(entry.liters * 1000) / 1000;
  entry.amount = Math.round(entry.amount * 100) / 100;
  return entry;
}

function validateVehicle(input) {
  const vehicle = { name: String(input.name || '').trim().slice(0, 60), make: String(input.make || '').trim().slice(0, 50), model: String(input.model || '').trim().slice(0, 60), plate: String(input.plate || '').trim().toUpperCase().slice(0, 10), fuelType: String(input.fuelType || 'Gasolina') };
  if (vehicle.name.length < 2) throw new Error('Informe um nome para o veículo.');
  if (!FUEL_TYPES.includes(vehicle.fuelType)) throw new Error('Selecione um combustível válido.');
  return vehicle;
}

function validateMaintenance(input) {
  const item = {
    vehicleId: String(input.vehicleId || ''), category: String(input.category || ''), description: String(input.description || '').trim().slice(0, 100),
    date: validDate(input.date), odometer: optionalNumber(input.odometer, 'uma quilometragem'), amount: optionalNumber(input.amount, 'um valor'),
    nextDate: validDate(input.nextDate, false), nextOdometer: optionalNumber(input.nextOdometer, 'a próxima quilometragem'), notes: String(input.notes || '').trim().slice(0, 240),
  };
  if (!item.vehicleId) throw new Error('Selecione um veículo.');
  if (!MAINTENANCE_CATEGORIES.includes(item.category)) throw new Error('Selecione uma categoria válida.');
  if (item.description.length < 2) throw new Error('Descreva o serviço ou despesa.');
  return item;
}

class FuelStore {
  constructor(dbPath, legacyJsonPath = '') { this.dbPath = dbPath; this.legacyJsonPath = legacyJsonPath; this.db = null; }

  async init() {
    await fs.mkdir(path.dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS app_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS vehicles (id TEXT PRIMARY KEY, name TEXT NOT NULL, make TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '', plate TEXT NOT NULL DEFAULT '', fuel_type TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT);
      CREATE TABLE IF NOT EXISTS fuel_entries (id TEXT PRIMARY KEY, vehicle_id TEXT NOT NULL REFERENCES vehicles(id) ON DELETE RESTRICT, date TEXT NOT NULL, fuel_type TEXT NOT NULL, liters REAL NOT NULL, amount REAL NOT NULL, station TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', odometer REAL, full_tank INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT);
      CREATE TABLE IF NOT EXISTS maintenance (id TEXT PRIMARY KEY, vehicle_id TEXT NOT NULL REFERENCES vehicles(id) ON DELETE RESTRICT, category TEXT NOT NULL, description TEXT NOT NULL, date TEXT NOT NULL, odometer REAL, amount REAL, next_date TEXT NOT NULL DEFAULT '', next_odometer REAL, notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT);
      CREATE INDEX IF NOT EXISTS idx_fuel_vehicle_date ON fuel_entries(vehicle_id, date DESC);
      CREATE INDEX IF NOT EXISTS idx_maintenance_vehicle_date ON maintenance(vehicle_id, date DESC);
      CREATE INDEX IF NOT EXISTS idx_maintenance_next_date ON maintenance(next_date) WHERE next_date != '';
      PRAGMA optimize;
    `);
    const defaultVehicle = this.ensureDefaultVehicle();
    await this.migrateLegacyJson(defaultVehicle.id);
  }

  ensureDefaultVehicle() {
    let row = this.db.prepare('SELECT * FROM vehicles ORDER BY created_at LIMIT 1').get();
    if (!row) {
      const id = crypto.randomUUID();
      this.db.prepare('INSERT INTO vehicles (id, name, fuel_type, created_at) VALUES (?, ?, ?, ?)').run(id, 'Meu veículo', 'Gasolina', new Date().toISOString());
      row = this.db.prepare('SELECT * FROM vehicles WHERE id = ?').get(id);
    }
    return this.mapVehicle(row);
  }

  async migrateLegacyJson(vehicleId) {
    if (this.db.prepare("SELECT value FROM app_metadata WHERE key = 'legacy_json_migrated'").get()) return;
    let records = [];
    if (this.legacyJsonPath) {
      try { const parsed = JSON.parse(await fs.readFile(this.legacyJsonPath, 'utf8')); if (Array.isArray(parsed)) records = parsed; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const insert = this.db.prepare(`INSERT OR IGNORE INTO fuel_entries (id, vehicle_id, date, fuel_type, liters, amount, station, notes, odometer, full_tank, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const old of records) {
        const valid = validateEntry({ ...old, vehicleId, fullTank: old.fullTank ?? true });
        insert.run(old.id || crypto.randomUUID(), vehicleId, valid.date, valid.fuelType, valid.liters, valid.amount, valid.station, valid.notes, valid.odometer, valid.fullTank ? 1 : 0, old.createdAt || new Date().toISOString(), old.updatedAt || null);
      }
      this.db.prepare("INSERT INTO app_metadata (key, value) VALUES ('legacy_json_migrated', ?)").run(new Date().toISOString());
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  vehicleExists(id) { return Boolean(this.db.prepare('SELECT 1 FROM vehicles WHERE id = ?').get(id)); }
  listVehicles() { return this.db.prepare('SELECT * FROM vehicles ORDER BY created_at').all().map((row) => this.mapVehicle(row)); }
  getVehicle(id) { const row = this.db.prepare('SELECT * FROM vehicles WHERE id = ?').get(id); return row ? this.mapVehicle(row) : null; }
  mapVehicle(row) { return { id: row.id, name: row.name, make: row.make, model: row.model, plate: row.plate, fuelType: row.fuel_type, createdAt: row.created_at, updatedAt: row.updated_at }; }

  createVehicle(input) {
    const valid = validateVehicle(input); const id = crypto.randomUUID(); const now = new Date().toISOString();
    this.db.prepare('INSERT INTO vehicles (id, name, make, model, plate, fuel_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, valid.name, valid.make, valid.model, valid.plate, valid.fuelType, now);
    return this.getVehicle(id);
  }
  updateVehicle(id, input) {
    if (!this.vehicleExists(id)) return null;
    const valid = validateVehicle(input);
    this.db.prepare('UPDATE vehicles SET name=?, make=?, model=?, plate=?, fuel_type=?, updated_at=? WHERE id=?').run(valid.name, valid.make, valid.model, valid.plate, valid.fuelType, new Date().toISOString(), id);
    return this.getVehicle(id);
  }

  list(vehicleId = '') {
    const rows = vehicleId ? this.db.prepare('SELECT * FROM fuel_entries WHERE vehicle_id = ? ORDER BY date DESC, created_at DESC').all(vehicleId) : this.db.prepare('SELECT * FROM fuel_entries ORDER BY date DESC, created_at DESC').all();
    return rows.map((row) => this.mapEntry(row));
  }
  getEntry(id) { const row = this.db.prepare('SELECT * FROM fuel_entries WHERE id = ?').get(id); return row ? this.mapEntry(row) : null; }
  mapEntry(row) { return { id: row.id, vehicleId: row.vehicle_id, date: row.date, fuelType: row.fuel_type, liters: row.liters, amount: row.amount, station: row.station, notes: row.notes, odometer: row.odometer, fullTank: row.full_tank === 1, createdAt: row.created_at, updatedAt: row.updated_at }; }
  create(input) {
    const valid = validateEntry(input); if (!this.vehicleExists(valid.vehicleId)) throw new Error('Veículo não encontrado.');
    const id = crypto.randomUUID(); const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO fuel_entries (id, vehicle_id, date, fuel_type, liters, amount, station, notes, odometer, full_tank, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, valid.vehicleId, valid.date, valid.fuelType, valid.liters, valid.amount, valid.station, valid.notes, valid.odometer, valid.fullTank ? 1 : 0, now);
    return this.getEntry(id);
  }
  update(id, input) {
    if (!this.getEntry(id)) return null;
    const valid = validateEntry(input); if (!this.vehicleExists(valid.vehicleId)) throw new Error('Veículo não encontrado.');
    this.db.prepare(`UPDATE fuel_entries SET vehicle_id=?, date=?, fuel_type=?, liters=?, amount=?, station=?, notes=?, odometer=?, full_tank=?, updated_at=? WHERE id=?`)
      .run(valid.vehicleId, valid.date, valid.fuelType, valid.liters, valid.amount, valid.station, valid.notes, valid.odometer, valid.fullTank ? 1 : 0, new Date().toISOString(), id);
    return this.getEntry(id);
  }
  remove(id) { return this.db.prepare('DELETE FROM fuel_entries WHERE id = ?').run(id).changes > 0; }

  listMaintenance(vehicleId = '') {
    const rows = vehicleId ? this.db.prepare('SELECT * FROM maintenance WHERE vehicle_id = ? ORDER BY date DESC, created_at DESC').all(vehicleId) : this.db.prepare('SELECT * FROM maintenance ORDER BY date DESC, created_at DESC').all();
    return rows.map((row) => this.mapMaintenance(row));
  }
  getMaintenance(id) { const row = this.db.prepare('SELECT * FROM maintenance WHERE id = ?').get(id); return row ? this.mapMaintenance(row) : null; }
  mapMaintenance(row) { return { id: row.id, vehicleId: row.vehicle_id, category: row.category, description: row.description, date: row.date, odometer: row.odometer, amount: row.amount, nextDate: row.next_date, nextOdometer: row.next_odometer, notes: row.notes, createdAt: row.created_at, updatedAt: row.updated_at }; }
  createMaintenance(input) {
    const valid = validateMaintenance(input); if (!this.vehicleExists(valid.vehicleId)) throw new Error('Veículo não encontrado.');
    const id = crypto.randomUUID(); const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO maintenance (id, vehicle_id, category, description, date, odometer, amount, next_date, next_odometer, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, valid.vehicleId, valid.category, valid.description, valid.date, valid.odometer, valid.amount, valid.nextDate, valid.nextOdometer, valid.notes, now);
    return this.getMaintenance(id);
  }
  updateMaintenance(id, input) {
    if (!this.getMaintenance(id)) return null;
    const valid = validateMaintenance(input); if (!this.vehicleExists(valid.vehicleId)) throw new Error('Veículo não encontrado.');
    this.db.prepare(`UPDATE maintenance SET vehicle_id=?, category=?, description=?, date=?, odometer=?, amount=?, next_date=?, next_odometer=?, notes=?, updated_at=? WHERE id=?`)
      .run(valid.vehicleId, valid.category, valid.description, valid.date, valid.odometer, valid.amount, valid.nextDate, valid.nextOdometer, valid.notes, new Date().toISOString(), id);
    return this.getMaintenance(id);
  }
  removeMaintenance(id) { return this.db.prepare('DELETE FROM maintenance WHERE id = ?').run(id).changes > 0; }

  backup() { return { version: 1, exportedAt: new Date().toISOString(), vehicles: this.listVehicles(), fuelEntries: this.list(), maintenance: this.listMaintenance() }; }
  close() { if (this.db) this.db.close(); }
}

module.exports = { FuelStore, FUEL_TYPES, MAINTENANCE_CATEGORIES, validateEntry, validateVehicle, validateMaintenance };
