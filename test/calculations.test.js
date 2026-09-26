const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateConsumption, compareEntriesNewestFirst } = require('../public/calculations');

function entry(id, date, liters, amount, odometer, fullTank, time = '') {
  return { id, date, time, liters, amount, odometer, fullTank, createdAt: `${date}T12:00:00.000Z` };
}

test('soma abastecimentos parciais sem hodômetro entre dois tanques completos', () => {
  const result = calculateConsumption([
    entry('full-start', '2026-09-11', 5.178, 19.93, 121753, true),
    entry('partial-1', '2026-09-14', 25.707, 100, null, false),
    entry('partial-2', '2026-09-16', 30, 102.59, null, false),
    entry('full-end', '2026-09-17', 21.47, 74.50, 122320, true),
  ]);

  assert.equal(result.samples.length, 1);
  assert.equal(result.samples[0].distance, 567);
  assert.ok(Math.abs(result.samples[0].liters - 77.177) < 0.000001);
  assert.ok(Math.abs(result.kmPerLiter - (567 / 77.177)) < 0.000001);
  assert.ok(Math.abs(result.costPerKm - (277.09 / 567)) < 0.000001);
});

test('não usa o abastecimento cheio inicial no combustível consumido pelo ciclo', () => {
  const result = calculateConsumption([
    entry('start', '2026-01-01', 50, 300, 1000, true),
    entry('end', '2026-01-10', 40, 240, 1400, true),
  ]);

  assert.equal(result.samples[0].liters, 40);
  assert.equal(result.kmPerLiter, 10);
  assert.equal(result.costPerKm, 0.6);
});

test('tanque completo sem hodômetro continua acumulado até um fechamento calculável', () => {
  const result = calculateConsumption([
    entry('start', '2026-01-01', 40, 220, 1000, true),
    entry('full-no-odometer', '2026-01-05', 20, 110, null, true),
    entry('end', '2026-01-10', 30, 165, 1500, true),
  ]);

  assert.equal(result.samples.length, 1);
  assert.equal(result.samples[0].liters, 50);
  assert.equal(result.kmPerLiter, 10);
});

test('reordena abastecimentos do mesmo dia pela hora antes de calcular', () => {
  const result = calculateConsumption([
    entry('full-end', '2026-09-20', 30, 180, 1400, true, '18:30'),
    entry('full-start', '2026-09-19', 40, 240, 1000, true, '20:00'),
    entry('partial', '2026-09-20', 10, 60, 1250, false, '09:15'),
  ]);

  assert.equal(result.samples.length, 1);
  assert.equal(result.samples[0].liters, 40);
  assert.equal(result.samples[0].distance, 400);
  assert.equal(result.kmPerLiter, 10);
  assert.equal(result.costPerKm, 0.6);
});

test('registro sem hora é tratado como início do dia', () => {
  const result = calculateConsumption([
    entry('full-end', '2026-09-20', 30, 180, 1400, true, '18:30'),
    entry('partial', '2026-09-20', 10, 60, 1200, false),
    entry('full-start', '2026-09-19', 40, 240, 1000, true, '20:00'),
  ]);

  assert.equal(result.samples[0].liters, 40);
  assert.equal(result.kmPerLiter, 10);
});

test('ordena o histórico novamente ao editar data ou hora', () => {
  const entries = [
    entry('morning', '2026-09-20', 10, 60, 1000, false, '08:00'),
    entry('next-day', '2026-09-21', 10, 60, 1100, false, '07:00'),
    entry('evening', '2026-09-20', 10, 60, 1050, false, '19:00'),
  ];

  assert.deepEqual(entries.sort(compareEntriesNewestFirst).map((item) => item.id), ['next-day', 'evening', 'morning']);
});
