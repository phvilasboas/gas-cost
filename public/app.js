const state = {
  vehicles: [], entries: [], maintenance: [], selectedVehicleId: '',
  period: 'all', fuel: 'all', editingId: null, editingVehicleId: null,
  editingMaintenanceId: null, deferredInstall: null,
};

const $ = (selector) => document.querySelector(selector);
const money = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const number = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 3 });
const integer = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });
const dateFormat = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' });
const monthFormat = new Intl.DateTimeFormat('pt-BR', { month: 'short' });
const colors = { Gasolina: '#277c59', Etanol: '#e78546', Diesel: '#5d91a8', GNV: '#9b7cba', Outro: '#9a9588' };
const { calculateConsumption, compareEntriesNewestFirst } = globalThis.GasCostCalculations;

function localDate() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function dateValue(value) { return new Date(`${value}T12:00:00`); }
function vehicleEntries() { return state.entries.filter((entry) => entry.vehicleId === state.selectedVehicleId).sort(compareEntriesNewestFirst); }
function vehicleMaintenance() { return state.maintenance.filter((item) => item.vehicleId === state.selectedVehicleId); }

function inPeriod(entry) {
  if (state.period === 'all') return true;
  const value = dateValue(entry.date);
  const now = new Date();
  if (state.period === 'month') return value.getMonth() === now.getMonth() && value.getFullYear() === now.getFullYear();
  if (state.period === 'year') return value.getFullYear() === now.getFullYear();
  const limit = new Date(); limit.setHours(0, 0, 0, 0); limit.setDate(limit.getDate() - 30);
  return value >= limit;
}

function escapeHtml(value) {
  const div = document.createElement('div'); div.textContent = String(value ?? ''); return div.innerHTML;
}

function api(url, options = {}) {
  return fetch(url, options).then(async (response) => {
    if (response.status === 401) { location.replace('/'); throw new Error('Sessão encerrada.'); }
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || 'Não foi possível concluir a operação.');
    return result;
  });
}

function render() {
  const allVehicleEntries = vehicleEntries();
  const periodEntries = allVehicleEntries.filter(inPeriod);
  const visible = periodEntries.filter((entry) => state.fuel === 'all' || entry.fuelType === state.fuel);
  const total = periodEntries.reduce((sum, entry) => sum + entry.amount, 0);
  const liters = periodEntries.reduce((sum, entry) => sum + entry.liters, 0);
  const allConsumption = calculateConsumption(allVehicleEntries);
  const periodSamples = allConsumption.samples.filter(inPeriod);
  const sampleDistance = periodSamples.reduce((sum, sample) => sum + sample.distance, 0);
  const sampleLiters = periodSamples.reduce((sum, sample) => sum + sample.liters, 0);
  const sampleAmount = periodSamples.reduce((sum, sample) => sum + sample.amount, 0);
  const consumption = sampleLiters ? sampleDistance / sampleLiters : null;
  const costPerKm = sampleDistance ? sampleAmount / sampleDistance : null;

  $('#total-spent').textContent = money.format(total);
  $('#total-liters').textContent = `${number.format(liters)} L`;
  $('#average-price').textContent = `${money.format(liters ? total / liters : 0)}/L`;
  $('#entry-count').textContent = periodEntries.length === 1 ? '1 abastecimento' : `${periodEntries.length} abastecimentos`;
  $('#average-consumption').textContent = consumption ? `${number.format(consumption)} km/L` : '— km/L';
  $('#cost-per-km').textContent = costPerKm ? `${money.format(costPerKm)} por km` : 'Complete dois tanques com hodômetro';

  const sampleMap = new Map(allConsumption.samples.map((sample) => [sample.entryId, sample]));
  $('#entries').innerHTML = visible.map((entry) => {
    const sample = sampleMap.get(entry.id);
    const entryDate = `${dateFormat.format(dateValue(entry.date))}${entry.time ? ` às ${escapeHtml(entry.time)}` : ''}`;
    const details = [entryDate, entry.station && escapeHtml(entry.station), entry.odometer !== null && `${integer.format(entry.odometer)} km`].filter(Boolean).join(' · ');
    return `<article class="entry">
      <span class="fuel-dot" style="color:${colors[entry.fuelType] || colors.Outro}">●</span>
      <div class="entry-main"><strong>${escapeHtml(entry.fuelType)}</strong><small>${details}</small>${sample ? `<em>${number.format(sample.kmPerLiter)} km/L · ${money.format(sample.costPerKm)}/km</em>` : ''}</div>
      <div class="entry-number"><strong>${number.format(entry.liters)} L</strong><small>${money.format(entry.amount / entry.liters)}/L</small></div>
      <div class="entry-number"><strong>${money.format(entry.amount)}</strong><small>${entry.fullTank ? 'tanque completo' : 'abastecimento parcial'}</small></div>
      <div class="entry-actions"><button class="edit-button" data-edit="${entry.id}" type="button" aria-label="Editar abastecimento">✎</button><button class="delete-button" data-delete="${entry.id}" type="button" aria-label="Excluir abastecimento">×</button></div>
    </article>`;
  }).join('');
  $('#empty-state').hidden = visible.length > 0;
  renderFuelChart(periodEntries, allConsumption);
  renderMonthlyChart(allVehicleEntries);
  renderStations(periodEntries);
  renderMaintenance();
}

function renderFuelChart(entries, consumption) {
  const fuels = entries.reduce((acc, entry) => {
    const current = acc[entry.fuelType] || { amount: 0, liters: 0, count: 0 };
    current.amount += entry.amount; current.liters += entry.liters; current.count += 1; acc[entry.fuelType] = current; return acc;
  }, {});
  const totalAmount = entries.reduce((sum, entry) => sum + entry.amount, 0);
  const sorted = Object.entries(fuels).sort((a, b) => b[1].amount - a[1].amount);
  $('#fuel-chart').innerHTML = sorted.length ? sorted.map(([fuel, values]) => {
    const share = values.amount / totalAmount * 100; const average = values.amount / values.liters;
    return `<div class="chart-row"><div class="chart-label"><span class="chart-dot" style="background:${colors[fuel] || colors.Outro}"></span><strong>${escapeHtml(fuel)}</strong><small>${values.count} ${values.count === 1 ? 'abastecimento' : 'abastecimentos'}</small></div><div class="bar-track" title="${Math.round(share)}% dos gastos"><div class="bar" style="width:${share}%;background:${colors[fuel] || colors.Outro}"></div></div><div class="chart-average"><strong>${money.format(average)}/L</strong><small>${Math.round(share)}% dos gastos</small></div></div>`;
  }).join('') : '<p class="muted-copy">As médias aparecerão depois do primeiro registro.</p>';

  const samples = consumption.samples;
  let insight = sorted.length ? `${sorted[0][0]} representa ${Math.round(sorted[0][1].amount / totalAmount * 100)}% dos gastos, com média de ${money.format(sorted[0][1].amount / sorted[0][1].liters)} por litro.` : 'Adicione registros para descobrir seu combustível mais usado.';
  if (samples.length >= 3) {
    const latest = samples.at(-1); const prior = samples.slice(0, -1); const priorAverage = prior.reduce((sum, sample) => sum + sample.distance, 0) / prior.reduce((sum, sample) => sum + sample.liters, 0);
    if (latest.kmPerLiter < priorAverage * 0.85) insight = `Atenção: o consumo mais recente ficou ${Math.round((1 - latest.kmPerLiter / priorAverage) * 100)}% abaixo da média anterior.`;
  }
  $('#insight-text').textContent = insight;
}

function lastSixMonths() {
  const now = new Date(); const months = [];
  for (let offset = 5; offset >= 0; offset -= 1) {
    const value = new Date(now.getFullYear(), now.getMonth() - offset, 1);
    months.push({ key: `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}`, label: monthFormat.format(value).replace('.', '') });
  }
  return months;
}

function renderMonthlyChart(entries) {
  const months = lastSixMonths().map((month) => ({ ...month, amount: 0, liters: 0 }));
  const lookup = new Map(months.map((month) => [month.key, month]));
  entries.forEach((entry) => { const month = lookup.get(entry.date.slice(0, 7)); if (month) { month.amount += entry.amount; month.liters += entry.liters; } });
  const maximum = Math.max(...months.map((month) => month.amount), 1);
  $('#monthly-chart').innerHTML = months.map((month) => `<div class="month-column"><strong>${month.amount ? money.format(month.amount) : '—'}</strong><div class="month-track"><span style="height:${Math.max(month.amount ? 8 : 0, month.amount / maximum * 100)}%"></span></div><small>${escapeHtml(month.label)}</small></div>`).join('');
  const current = months.at(-1).amount; const previous = months.at(-2).amount;
  if (!previous) { $('#month-comparison').textContent = current ? 'Primeiro mês comparável' : 'Sem dados recentes'; $('#month-comparison').className = 'comparison'; }
  else {
    const change = (current - previous) / previous * 100;
    $('#month-comparison').textContent = `${change > 0 ? '↑' : change < 0 ? '↓' : '→'} ${Math.abs(change).toFixed(0)}% vs. mês anterior`;
    $('#month-comparison').className = `comparison ${change > 0 ? 'up' : 'down'}`;
  }
}

function renderStations(entries) {
  const withStation = entries.filter((entry) => entry.station);
  const stations = Object.values(withStation.reduce((acc, entry) => {
    const key = entry.station.toLocaleLowerCase('pt-BR');
    acc[key] ||= { name: entry.station, amount: 0, liters: 0, count: 0 };
    acc[key].amount += entry.amount; acc[key].liters += entry.liters; acc[key].count += 1; return acc;
  }, {})).sort((a, b) => a.amount / a.liters - b.amount / b.liters);
  if (!stations.length) { $('#station-list').innerHTML = '<div class="empty-inline"><strong>Informe o posto ao abastecer</strong><span>Assim você descobre onde costuma pagar menos.</span></div>'; return; }
  const minimumByFuel = {};
  withStation.forEach((entry) => { const price = entry.amount / entry.liters; minimumByFuel[entry.fuelType] = Math.min(minimumByFuel[entry.fuelType] ?? Infinity, price); });
  const potential = withStation.reduce((sum, entry) => sum + Math.max(0, entry.amount / entry.liters - minimumByFuel[entry.fuelType]) * entry.liters, 0);
  $('#station-list').innerHTML = `${stations.map((station, index) => `<div class="station-row"><span class="station-rank">${index + 1}</span><div><strong>${escapeHtml(station.name)}</strong><small>${station.count} ${station.count === 1 ? 'visita' : 'visitas'} · ${number.format(station.liters)} L</small></div><b>${money.format(station.amount / station.liters)}/L</b></div>`).join('')}<p class="station-saving">Economia potencial no período: <strong>${money.format(potential)}</strong></p>`;
}

function maintenanceStatus(item, latestOdometer) {
  const today = dateValue(localDate()); const inThirtyDays = new Date(today); inThirtyDays.setDate(inThirtyDays.getDate() + 30);
  const dueDate = item.nextDate && dateValue(item.nextDate) <= today;
  const soonDate = item.nextDate && dateValue(item.nextDate) <= inThirtyDays;
  const dueKm = item.nextOdometer !== null && latestOdometer !== null && item.nextOdometer <= latestOdometer;
  const soonKm = item.nextOdometer !== null && latestOdometer !== null && item.nextOdometer - latestOdometer <= 1000;
  if (dueDate || dueKm) return { level: 2, label: 'Vencida' };
  if (soonDate || soonKm) return { level: 1, label: 'Próxima' };
  return { level: 0, label: '' };
}

function renderMaintenance() {
  const items = vehicleMaintenance();
  const odometers = vehicleEntries().map((entry) => entry.odometer).filter((value) => value !== null);
  const latestOdometer = odometers.length ? Math.max(...odometers) : null;
  const enriched = items.map((item) => ({ item, status: maintenanceStatus(item, latestOdometer) }))
    .sort((a, b) => b.status.level - a.status.level || b.item.date.localeCompare(a.item.date));
  $('#maintenance-list').innerHTML = enriched.map(({ item, status }) => {
    const next = [item.nextDate && `até ${dateFormat.format(dateValue(item.nextDate))}`, item.nextOdometer !== null && `aos ${integer.format(item.nextOdometer)} km`].filter(Boolean).join(' ou ');
    return `<article class="maintenance-item"><span class="maintenance-icon">${escapeHtml(item.category.slice(0, 1))}</span><div class="maintenance-main"><strong>${escapeHtml(item.description)}</strong><small>${escapeHtml(item.category)} · ${dateFormat.format(dateValue(item.date))}${item.odometer !== null ? ` · ${integer.format(item.odometer)} km` : ''}</small>${next ? `<em>Próximo: ${escapeHtml(next)}</em>` : ''}</div>${status.label ? `<span class="status-badge status-${status.level}">${status.label}</span>` : ''}<b>${item.amount !== null ? money.format(item.amount) : '—'}</b><div class="entry-actions"><button class="edit-button" data-maintenance-edit="${item.id}" type="button" aria-label="Editar manutenção">✎</button><button class="delete-button" data-maintenance-delete="${item.id}" type="button" aria-label="Excluir manutenção">×</button></div></article>`;
  }).join('');
  $('#maintenance-empty').hidden = items.length > 0;
  const alerts = enriched.filter(({ status }) => status.level > 0);
  $('#reminder-banner').hidden = alerts.length === 0;
  if (alerts.length) $('#reminder-title').textContent = alerts.length === 1 ? `1 cuidado ${alerts[0].status.level === 2 ? 'vencido' : 'se aproximando'}` : `${alerts.length} cuidados precisam de atenção`;
}

function fillVehicleSelectors() {
  const options = state.vehicles.map((vehicle) => `<option value="${vehicle.id}">${escapeHtml(vehicle.name)}${vehicle.plate ? ` · ${escapeHtml(vehicle.plate)}` : ''}</option>`).join('');
  ['#vehicle-filter', '#entry-vehicle', '#maintenance-vehicle'].forEach((selector) => { $(selector).innerHTML = options; });
  $('#vehicle-filter').value = state.selectedVehicleId; $('#entry-vehicle').value = state.selectedVehicleId; $('#maintenance-vehicle').value = state.selectedVehicleId;
}

function openEntryForm(entry = null) {
  const form = $('#entry-form'); form.reset(); $('#form-error').textContent = ''; state.editingId = entry?.id || null;
  $('#form-eyebrow').textContent = entry ? 'AJUSTAR REGISTRO' : 'NOVO REGISTRO'; $('#form-title').textContent = entry ? 'Editar abastecimento' : 'Adicionar abastecimento'; $('#save-entry').textContent = entry ? 'Salvar alterações' : 'Salvar abastecimento';
  form.elements.vehicleId.value = entry?.vehicleId || state.selectedVehicleId; form.elements.date.value = entry?.date || localDate(); form.elements.time.value = entry?.time || '';
  if (entry) { form.elements.fuelType.value = entry.fuelType; form.elements.liters.value = entry.liters; form.elements.amount.value = entry.amount; form.elements.odometer.value = entry.odometer ?? ''; form.elements.fullTank.checked = entry.fullTank; form.elements.station.value = entry.station || ''; form.elements.notes.value = entry.notes || ''; }
  $('#entry-dialog').showModal();
}

function openVehicleForm(vehicle = null) {
  const form = $('#vehicle-form'); form.reset(); $('#vehicle-error').textContent = ''; state.editingVehicleId = vehicle?.id || null;
  $('#vehicle-eyebrow').textContent = vehicle ? 'AJUSTAR VEÍCULO' : 'NOVO VEÍCULO'; $('#vehicle-title').textContent = vehicle ? 'Editar veículo' : 'Adicionar veículo';
  if (vehicle) ['name', 'make', 'model', 'plate', 'fuelType'].forEach((field) => { form.elements[field].value = vehicle[field] || ''; });
  $('#vehicle-dialog').showModal();
}

function openMaintenanceForm(item = null) {
  const form = $('#maintenance-form'); form.reset(); $('#maintenance-error').textContent = ''; state.editingMaintenanceId = item?.id || null;
  $('#maintenance-eyebrow').textContent = item ? 'AJUSTAR REGISTRO' : 'NOVO REGISTRO'; $('#maintenance-title').textContent = item ? 'Editar manutenção' : 'Adicionar manutenção';
  form.elements.vehicleId.value = item?.vehicleId || state.selectedVehicleId; form.elements.date.value = item?.date || localDate();
  if (item) ['category', 'description', 'odometer', 'amount', 'nextDate', 'nextOdometer', 'notes'].forEach((field) => { form.elements[field].value = item[field] ?? ''; });
  $('#maintenance-dialog').showModal();
}

function closeDialog(dialog) { dialog.close(); }
function toast(message) { const element = $('#toast'); element.textContent = message; element.classList.add('show'); clearTimeout(toast.timeout); toast.timeout = setTimeout(() => element.classList.remove('show'), 2400); }

async function submitJson(form, endpoint, method) {
  const formData = new FormData(form); const data = Object.fromEntries(formData);
  if (form === $('#entry-form')) data.fullTank = formData.has('fullTank');
  return api(endpoint, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
}

$('#entry-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const id = state.editingId;
  try {
    const result = await submitJson(event.currentTarget, id ? `/api/entries/${id}` : '/api/entries', id ? 'PUT' : 'POST');
    state.entries = id ? state.entries.map((item) => item.id === id ? result : item) : [result, ...state.entries];
    closeDialog($('#entry-dialog')); render(); toast(id ? 'Abastecimento atualizado.' : 'Abastecimento salvo.');
  } catch (error) { $('#form-error').textContent = error.message; }
});

$('#vehicle-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const id = state.editingVehicleId;
  try {
    const result = await submitJson(event.currentTarget, id ? `/api/vehicles/${id}` : '/api/vehicles', id ? 'PUT' : 'POST');
    state.vehicles = id ? state.vehicles.map((item) => item.id === id ? result : item) : [...state.vehicles, result]; state.selectedVehicleId = result.id;
    localStorage.setItem('gascost.vehicle', result.id); fillVehicleSelectors(); closeDialog($('#vehicle-dialog')); render(); toast(id ? 'Veículo atualizado.' : 'Veículo adicionado.');
  } catch (error) { $('#vehicle-error').textContent = error.message; }
});

$('#maintenance-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const id = state.editingMaintenanceId;
  try {
    const result = await submitJson(event.currentTarget, id ? `/api/maintenance/${id}` : '/api/maintenance', id ? 'PUT' : 'POST');
    state.maintenance = id ? state.maintenance.map((item) => item.id === id ? result : item) : [result, ...state.maintenance];
    closeDialog($('#maintenance-dialog')); render(); toast(id ? 'Manutenção atualizada.' : 'Manutenção salva.');
  } catch (error) { $('#maintenance-error').textContent = error.message; }
});

$('#entries').addEventListener('click', async (event) => {
  const editId = event.target.closest('[data-edit]')?.dataset.edit;
  if (editId) { const entry = state.entries.find((item) => item.id === editId); if (entry) openEntryForm(entry); return; }
  const deleteId = event.target.closest('[data-delete]')?.dataset.delete;
  if (!deleteId || !confirm('Excluir este abastecimento?')) return;
  try { await api(`/api/entries/${deleteId}`, { method: 'DELETE' }); state.entries = state.entries.filter((item) => item.id !== deleteId); render(); toast('Abastecimento excluído.'); } catch (error) { toast(error.message); }
});

$('#maintenance-list').addEventListener('click', async (event) => {
  const editId = event.target.closest('[data-maintenance-edit]')?.dataset.maintenanceEdit;
  if (editId) { const item = state.maintenance.find((record) => record.id === editId); if (item) openMaintenanceForm(item); return; }
  const deleteId = event.target.closest('[data-maintenance-delete]')?.dataset.maintenanceDelete;
  if (!deleteId || !confirm('Excluir este registro de manutenção?')) return;
  try { await api(`/api/maintenance/${deleteId}`, { method: 'DELETE' }); state.maintenance = state.maintenance.filter((item) => item.id !== deleteId); render(); toast('Manutenção excluída.'); } catch (error) { toast(error.message); }
});

function csvCell(value) { return `"${String(value ?? '').replaceAll('"', '""')}"`; }
function xmlEscape(value) { return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;'); }
function download(content, type, filename) { const url = URL.createObjectURL(new Blob([content], { type })); const link = document.createElement('a'); link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
function exportRows() {
  const vehicle = state.vehicles.find((item) => item.id === state.selectedVehicleId);
  return vehicleEntries().map((entry) => [entry.date, entry.time || '', vehicle?.name || '', entry.fuelType, entry.liters, entry.amount, (entry.amount / entry.liters).toFixed(3), entry.odometer ?? '', entry.fullTank ? 'Sim' : 'Não', entry.station, entry.notes]);
}

$('#export-csv').addEventListener('click', () => {
  const headings = ['Data', 'Hora', 'Veículo', 'Combustível', 'Litros', 'Valor', 'Preço por litro', 'Hodômetro', 'Tanque completo', 'Posto', 'Observações'];
  const csv = [headings, ...exportRows()].map((row) => row.map(csvCell).join(';')).join('\r\n'); download(`\ufeff${csv}`, 'text/csv;charset=utf-8', `gascost-${localDate()}.csv`); toast('Relatório CSV preparado.');
});

$('#export-excel').addEventListener('click', () => {
  const headings = ['Data', 'Hora', 'Veículo', 'Combustível', 'Litros', 'Valor', 'Preço por litro', 'Hodômetro', 'Tanque completo', 'Posto', 'Observações'];
  const sheet = [headings, ...exportRows()].map((row) => `<Row>${row.map((cell) => `<Cell><Data ss:Type="String">${xmlEscape(cell)}</Data></Cell>`).join('')}</Row>`).join('');
  const maintenanceRows = vehicleMaintenance().map((item) => [item.date, item.category, item.description, item.odometer ?? '', item.amount ?? '', item.nextDate, item.nextOdometer ?? '', item.notes]);
  const maintenanceHeadings = ['Data', 'Categoria', 'Descrição', 'Hodômetro', 'Valor', 'Próxima data', 'Próxima quilometragem', 'Observações'];
  const maintenanceSheet = [maintenanceHeadings, ...maintenanceRows].map((row) => `<Row>${row.map((cell) => `<Cell><Data ss:Type="String">${xmlEscape(cell)}</Data></Cell>`).join('')}</Row>`).join('');
  const workbook = `<?xml version="1.0"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Worksheet ss:Name="Abastecimentos"><Table>${sheet}</Table></Worksheet><Worksheet ss:Name="Manutenção"><Table>${maintenanceSheet}</Table></Worksheet></Workbook>`;
  download(workbook, 'application/vnd.ms-excel', `gascost-${localDate()}.xls`); toast('Planilha preparada.');
});

$('#download-backup').addEventListener('click', async () => {
  try { const backup = await api('/api/backup'); download(JSON.stringify(backup, null, 2), 'application/json', `gascost-backup-${localDate()}.json`); toast('Backup completo preparado.'); } catch (error) { toast(error.message); }
});

$('#vehicle-filter').addEventListener('change', (event) => { state.selectedVehicleId = event.target.value; localStorage.setItem('gascost.vehicle', state.selectedVehicleId); fillVehicleSelectors(); render(); });
$('#period').addEventListener('change', (event) => { state.period = event.target.value; render(); });
$('#fuel-filter').addEventListener('change', (event) => { state.fuel = event.target.value; render(); });
$('#open-form').addEventListener('click', () => openEntryForm());
document.querySelectorAll('[data-open-form]').forEach((button) => button.addEventListener('click', () => openEntryForm()));
$('#add-vehicle').addEventListener('click', () => openVehicleForm());
$('#manage-vehicle').addEventListener('click', () => openVehicleForm(state.vehicles.find((vehicle) => vehicle.id === state.selectedVehicleId)));
$('#add-maintenance').addEventListener('click', () => openMaintenanceForm());
$('#reminder-banner').addEventListener('click', () => $('#maintenance-section').scrollIntoView({ behavior: 'smooth' }));
document.querySelectorAll('[data-close-dialog]').forEach((button) => button.addEventListener('click', () => closeDialog(button.closest('dialog'))));
document.querySelectorAll('dialog').forEach((dialog) => dialog.addEventListener('click', (event) => { if (event.target === dialog) closeDialog(dialog); }));
$('#logout').addEventListener('click', async () => { try { await api('/api/auth/logout', { method: 'POST' }); } finally { location.replace('/'); } });

window.addEventListener('beforeinstallprompt', (event) => { event.preventDefault(); state.deferredInstall = event; $('#install-app').hidden = false; });
$('#install-app').addEventListener('click', async () => { if (!state.deferredInstall) return; state.deferredInstall.prompt(); await state.deferredInstall.userChoice; state.deferredInstall = null; $('#install-app').hidden = true; });
window.addEventListener('appinstalled', () => { state.deferredInstall = null; $('#install-app').hidden = true; toast('GasCost instalado.'); });

async function initialize() {
  try {
    const status = await api('/api/auth/status'); if (!status.authenticated) return location.replace('/'); $('#current-user').textContent = status.user.username;
    [state.vehicles, state.entries, state.maintenance] = await Promise.all([api('/api/vehicles'), api('/api/entries'), api('/api/maintenance')]);
    const saved = localStorage.getItem('gascost.vehicle'); state.selectedVehicleId = state.vehicles.some((vehicle) => vehicle.id === saved) ? saved : state.vehicles[0]?.id || '';
    fillVehicleSelectors(); render();
    if (new URLSearchParams(location.search).get('novo') === '1') { openEntryForm(); history.replaceState({}, '', '/'); }
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/service-worker.js').catch(() => {});
  } catch (error) { toast(error.message || 'Não foi possível carregar seus dados.'); }
}

initialize();
