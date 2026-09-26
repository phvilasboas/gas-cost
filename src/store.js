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

function validTime(value) {
  const time = String(value || '').trim();
  if (!time) return '';
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('Informe uma hora válida.');
  return time;
}

function optionalNumber(value, label) {
  if (value === '' || value === null || value === undefined) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 100_000_000) throw new Error(`Informe ${label} válida.`);
  return Math.round(number * 1000) / 1000;
}

function validateEntry(input) {
  const entry = {
    vehicleId: String(input.vehicleId || ''), date: validDate(input.date), time: validTime(input.time), fuelType: String(input.fuelType || ''),
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
      CREATE TABLE IF NOT EXISTS vehicles (id TEXT PRIMARY KEY, user_id INTEGER, name TEXT NOT NULL, make TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '', plate TEXT NOT NULL DEFAULT '', fuel_type TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT);
      CREATE TABLE IF NOT EXISTS fuel_entries (id TEXT PRIMARY KEY, vehicle_id TEXT NOT NULL REFERENCES vehicles(id) ON DELETE RESTRICT, date TEXT NOT NULL, time TEXT NOT NULL DEFAULT '', fuel_type TEXT NOT NULL, liters REAL NOT NULL, amount REAL NOT NULL, station TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', odometer REAL, full_tank INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT);
      CREATE TABLE IF NOT EXISTS maintenance (id TEXT PRIMARY KEY, vehicle_id TEXT NOT NULL REFERENCES vehicles(id) ON DELETE RESTRICT, category TEXT NOT NULL, description TEXT NOT NULL, date TEXT NOT NULL, odometer REAL, amount REAL, next_date TEXT NOT NULL DEFAULT '', next_odometer REAL, notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT);
      CREATE INDEX IF NOT EXISTS idx_fuel_vehicle_date ON fuel_entries(vehicle_id, date DESC);
      CREATE INDEX IF NOT EXISTS idx_maintenance_vehicle_date ON maintenance(vehicle_id, date DESC);
      CREATE INDEX IF NOT EXISTS idx_maintenance_next_date ON maintenance(next_date) WHERE next_date != '';
      PRAGMA optimize;
    `);
    const vehicleColumns = this.db.prepare('PRAGMA table_info(vehicles)').all();
    if (!vehicleColumns.some((column) => column.name === 'user_id')) this.db.exec('ALTER TABLE vehicles ADD COLUMN user_id INTEGER');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_vehicles_user ON vehicles(user_id, created_at)');
    const fuelColumns = this.db.prepare('PRAGMA table_info(fuel_entries)').all();
    if (!fuelColumns.some((column) => column.name === 'time')) this.db.exec("ALTER TABLE fuel_entries ADD COLUMN time TEXT NOT NULL DEFAULT ''");
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_fuel_vehicle_datetime ON fuel_entries(vehicle_id, date DESC, time DESC)');
  }

  validUserId(userId) {
    const value = Number(userId);
    if (!Number.isInteger(value) || value <= 0) throw new Error('Usuário inválido.');
    return value;
  }

  async initializeUser(userId, { claimUnowned = false } = {}) {
    const ownerId = this.validUserId(userId);
    if (claimUnowned) this.db.prepare('UPDATE vehicles SET user_id = ? WHERE user_id IS NULL').run(ownerId);
    const defaultVehicle = this.ensureDefaultVehicle(ownerId);
    if (claimUnowned) await this.migrateLegacyJson(defaultVehicle.id);
    return defaultVehicle;
  }

  ensureDefaultVehicle(userId) {
    const ownerId = this.validUserId(userId);
    let row = this.db.prepare('SELECT * FROM vehicles WHERE user_id = ? ORDER BY created_at LIMIT 1').get(ownerId);
    if (!row) {
      const id = crypto.randomUUID();
      this.db.prepare('INSERT INTO vehicles (id, user_id, name, fuel_type, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, ownerId, 'Meu veículo', 'Gasolina', new Date().toISOString());
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

  vehicleExists(userId, id) { return Boolean(this.db.prepare('SELECT 1 FROM vehicles WHERE id = ? AND user_id = ?').get(id, this.validUserId(userId))); }
  listVehicles(userId) { return this.db.prepare('SELECT * FROM vehicles WHERE user_id = ? ORDER BY created_at').all(this.validUserId(userId)).map((row) => this.mapVehicle(row)); }
  getVehicle(userId, id) { const row = this.db.prepare('SELECT * FROM vehicles WHERE id = ? AND user_id = ?').get(id, this.validUserId(userId)); return row ? this.mapVehicle(row) : null; }
  mapVehicle(row) { return { id: row.id, name: row.name, make: row.make, model: row.model, plate: row.plate, fuelType: row.fuel_type, createdAt: row.created_at, updatedAt: row.updated_at }; }

  createVehicle(userId, input) {
    const ownerId = this.validUserId(userId);
    const valid = validateVehicle(input); const id = crypto.randomUUID(); const now = new Date().toISOString();
    this.db.prepare('INSERT INTO vehicles (id, user_id, name, make, model, plate, fuel_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, ownerId, valid.name, valid.make, valid.model, valid.plate, valid.fuelType, now);
    return this.getVehicle(ownerId, id);
  }
  updateVehicle(userId, id, input) {
    const ownerId = this.validUserId(userId);
    if (!this.vehicleExists(ownerId, id)) return null;
    const valid = validateVehicle(input);
    this.db.prepare('UPDATE vehicles SET name=?, make=?, model=?, plate=?, fuel_type=?, updated_at=? WHERE id=? AND user_id=?').run(valid.name, valid.make, valid.model, valid.plate, valid.fuelType, new Date().toISOString(), id, ownerId);
    return this.getVehicle(ownerId, id);
  }

  list(userId, vehicleId = '') {
    const ownerId = this.validUserId(userId);
    const rows = vehicleId
      ? this.db.prepare(`SELECT e.* FROM fuel_entries e JOIN vehicles v ON v.id = e.vehicle_id
          WHERE e.vehicle_id = ? AND v.user_id = ? ORDER BY e.date DESC, e.time DESC, e.created_at DESC`).all(vehicleId, ownerId)
      : this.db.prepare(`SELECT e.* FROM fuel_entries e JOIN vehicles v ON v.id = e.vehicle_id
          WHERE v.user_id = ? ORDER BY e.date DESC, e.time DESC, e.created_at DESC`).all(ownerId);
    return rows.map((row) => this.mapEntry(row));
  }
  getEntry(userId, id) { const row = this.db.prepare(`SELECT e.* FROM fuel_entries e JOIN vehicles v ON v.id = e.vehicle_id
    WHERE e.id = ? AND v.user_id = ?`).get(id, this.validUserId(userId)); return row ? this.mapEntry(row) : null; }
  mapEntry(row) { return { id: row.id, vehicleId: row.vehicle_id, date: row.date, time: row.time || '', fuelType: row.fuel_type, liters: row.liters, amount: row.amount, station: row.station, notes: row.notes, odometer: row.odometer, fullTank: row.full_tank === 1, createdAt: row.created_at, updatedAt: row.updated_at }; }
  create(userId, input) {
    const ownerId = this.validUserId(userId);
    const valid = validateEntry(input); if (!this.vehicleExists(ownerId, valid.vehicleId)) throw new Error('Veículo não encontrado.');
    const id = crypto.randomUUID(); const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO fuel_entries (id, vehicle_id, date, time, fuel_type, liters, amount, station, notes, odometer, full_tank, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, valid.vehicleId, valid.date, valid.time, valid.fuelType, valid.liters, valid.amount, valid.station, valid.notes, valid.odometer, valid.fullTank ? 1 : 0, now);
    return this.getEntry(ownerId, id);
  }
  update(userId, id, input) {
    const ownerId = this.validUserId(userId);
    if (!this.getEntry(ownerId, id)) return null;
    const valid = validateEntry(input); if (!this.vehicleExists(ownerId, valid.vehicleId)) throw new Error('Veículo não encontrado.');
    this.db.prepare(`UPDATE fuel_entries SET vehicle_id=?, date=?, time=?, fuel_type=?, liters=?, amount=?, station=?, notes=?, odometer=?, full_tank=?, updated_at=? WHERE id=?`)
      .run(valid.vehicleId, valid.date, valid.time, valid.fuelType, valid.liters, valid.amount, valid.station, valid.notes, valid.odometer, valid.fullTank ? 1 : 0, new Date().toISOString(), id);
    return this.getEntry(ownerId, id);
  }
  remove(userId, id) { return this.db.prepare(`DELETE FROM fuel_entries WHERE id = ?
    AND vehicle_id IN (SELECT id FROM vehicles WHERE user_id = ?)`).run(id, this.validUserId(userId)).changes > 0; }

  listMaintenance(userId, vehicleId = '') {
    const ownerId = this.validUserId(userId);
    const rows = vehicleId
      ? this.db.prepare(`SELECT m.* FROM maintenance m JOIN vehicles v ON v.id = m.vehicle_id
          WHERE m.vehicle_id = ? AND v.user_id = ? ORDER BY m.date DESC, m.created_at DESC`).all(vehicleId, ownerId)
      : this.db.prepare(`SELECT m.* FROM maintenance m JOIN vehicles v ON v.id = m.vehicle_id
          WHERE v.user_id = ? ORDER BY m.date DESC, m.created_at DESC`).all(ownerId);
    return rows.map((row) => this.mapMaintenance(row));
  }
  getMaintenance(userId, id) { const row = this.db.prepare(`SELECT m.* FROM maintenance m JOIN vehicles v ON v.id = m.vehicle_id
    WHERE m.id = ? AND v.user_id = ?`).get(id, this.validUserId(userId)); return row ? this.mapMaintenance(row) : null; }
  mapMaintenance(row) { return { id: row.id, vehicleId: row.vehicle_id, category: row.category, description: row.description, date: row.date, odometer: row.odometer, amount: row.amount, nextDate: row.next_date, nextOdometer: row.next_odometer, notes: row.notes, createdAt: row.created_at, updatedAt: row.updated_at }; }
  createMaintenance(userId, input) {
    const ownerId = this.validUserId(userId);
    const valid = validateMaintenance(input); if (!this.vehicleExists(ownerId, valid.vehicleId)) throw new Error('Veículo não encontrado.');
    const id = crypto.randomUUID(); const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO maintenance (id, vehicle_id, category, description, date, odometer, amount, next_date, next_odometer, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, valid.vehicleId, valid.category, valid.description, valid.date, valid.odometer, valid.amount, valid.nextDate, valid.nextOdometer, valid.notes, now);
    return this.getMaintenance(ownerId, id);
  }
  updateMaintenance(userId, id, input) {
    const ownerId = this.validUserId(userId);
    if (!this.getMaintenance(ownerId, id)) return null;
    const valid = validateMaintenance(input); if (!this.vehicleExists(ownerId, valid.vehicleId)) throw new Error('Veículo não encontrado.');
    this.db.prepare(`UPDATE maintenance SET vehicle_id=?, category=?, description=?, date=?, odometer=?, amount=?, next_date=?, next_odometer=?, notes=?, updated_at=? WHERE id=?`)
      .run(valid.vehicleId, valid.category, valid.description, valid.date, valid.odometer, valid.amount, valid.nextDate, valid.nextOdometer, valid.notes, new Date().toISOString(), id);
    return this.getMaintenance(ownerId, id);
  }
  removeMaintenance(userId, id) { return this.db.prepare(`DELETE FROM maintenance WHERE id = ?
    AND vehicle_id IN (SELECT id FROM vehicles WHERE user_id = ?)`).run(id, this.validUserId(userId)).changes > 0; }

  backup(userId) { return { version: 2, exportedAt: new Date().toISOString(), vehicles: this.listVehicles(userId), fuelEntries: this.list(userId), maintenance: this.listMaintenance(userId) }; }
  close() { if (this.db) this.db.close(); }
}

module.exports = { FuelStore, FUEL_TYPES, MAINTENANCE_CATEGORIES, validateEntry, validateVehicle, validateMaintenance };
