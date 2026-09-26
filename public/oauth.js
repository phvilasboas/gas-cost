const $ = (selector) => document.querySelector(selector);
const params = Object.fromEntries(new URLSearchParams(location.search));
let csrf;
async function request(url, body) {
  const response = await fetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const value = await response.json();
  if (!response.ok) throw new Error(value.error_description || value.error || 'Não foi possível continuar.');
  return value;
}
async function initialize() {
  $('#error').textContent = '';
  try {
    const status = await request('/api/auth/status');
    $('#loading').hidden = true;
    if (!status.authenticated) {
      if (status.setupRequired) throw new Error('O administrador precisa configurar o GasCost antes de conectar.');
      $('#login').hidden = false; $('#consent').hidden = true; return;
    }
    const consent = await request('/oauth/prepare', params);
    csrf = consent.csrf;
    $('#account').textContent = status.user.username;
    $('#scopes').replaceChildren(...consent.scopes.map((scope) => {
      const item = document.createElement('li');
      item.textContent = { 'gascost:fuel:read': 'Veículos, abastecimentos e análises', 'gascost:maintenance:read': 'Veículos, manutenções e lembretes', offline_access: 'Manter a conexão com renovação automática' }[scope] || scope;
      return item;
    }));
    $('#login').hidden = true; $('#consent').hidden = false;
  } catch (error) { $('#loading').hidden = true; $('#error').textContent = error.message; }
}
$('#login').addEventListener('submit', async (event) => {
  event.preventDefault(); const button = event.currentTarget.querySelector('button'); button.disabled = true;
  try { await request('/api/auth/login', Object.fromEntries(new FormData(event.currentTarget))); event.currentTarget.reset(); await initialize(); }
  catch (error) { $('#error').textContent = error.message; }
  finally { button.disabled = false; }
});
async function decide(approved) {
  $('#allow').disabled = true; $('#deny').disabled = true;
  try { const result = await request('/oauth/consent', { csrf, approved }); location.assign(result.redirect); }
  catch (error) { $('#error').textContent = error.message; }
}
$('#allow').addEventListener('click', () => decide(true));
$('#deny').addEventListener('click', () => decide(false));
$('#switch-account').addEventListener('click', async () => { await request('/api/auth/logout', {}); await initialize(); });
initialize();
