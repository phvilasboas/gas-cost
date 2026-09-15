const form = document.querySelector('#auth-form');
const content = document.querySelector('#auth-content');
const loading = document.querySelector('#auth-loading');
const error = document.querySelector('#auth-error');
let setupRequired = false;

async function initialize() {
  try {
    const status = await fetch('/api/auth/status').then((response) => response.json());
    if (status.authenticated) return location.replace('/');
    setupRequired = status.setupRequired;
    if (setupRequired) {
      document.querySelector('#auth-eyebrow').textContent = 'PRIMEIRO ACESSO';
      document.querySelector('#auth-title').textContent = 'Crie sua conta';
      document.querySelector('#auth-description').textContent = 'Defina o administrador que terá acesso ao painel.';
      document.querySelector('#password-hint').hidden = false;
      document.querySelector('#bootstrap-field').hidden = false;
      form.bootstrapToken.required = true;
      form.password.autocomplete = 'new-password';
      document.querySelector('.auth-submit').textContent = 'Criar conta e entrar';
    }
    loading.hidden = true; content.hidden = false;
  } catch { loading.textContent = 'Não foi possível conectar à aplicação.'; }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault(); error.textContent = '';
  const button = document.querySelector('.auth-submit');
  button.disabled = true; button.textContent = setupRequired ? 'Criando conta...' : 'Entrando...';
  const data = Object.fromEntries(new FormData(form));
  try {
    const endpoint = setupRequired ? '/api/auth/setup' : '/api/auth/login';
    const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    location.replace('/');
  } catch (failure) {
    error.textContent = failure.message || 'Não foi possível entrar.';
    button.disabled = false; button.textContent = setupRequired ? 'Criar conta e entrar' : 'Entrar';
  }
});

initialize();
