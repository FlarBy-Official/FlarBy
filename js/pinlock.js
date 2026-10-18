import { el, esc } from './core.js';

const KEY = 'fc_pin';
const AWAY_MS = 15000;

async function hash(pin, salt) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(salt + ':' + pin));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export function hasPin() { return !!localStorage.getItem(KEY); }
export function removePin() { localStorage.removeItem(KEY); }

export async function setPin(pin) {
  if (!/^\d{4,6}$/.test(pin)) throw new Error('Die PIN muss aus 4 bis 6 Ziffern bestehen.');
  const salt = crypto.getRandomValues(new Uint8Array(16)).reduce((s, b) => s + b.toString(16).padStart(2, '0'), '');
  localStorage.setItem(KEY, JSON.stringify({ salt, hash: await hash(pin, salt) }));
}

export async function checkPin(pin) {
  try {
    const { salt, hash: h } = JSON.parse(localStorage.getItem(KEY));
    return (await hash(pin, salt)) === h;
  } catch { return false; }
}

export function lockNow(onForgot) {
  if (!hasPin() || document.getElementById('pinlock')) return;
  const input = el('input', { type: 'password', inputmode: 'numeric', maxlength: '6', autocomplete: 'off', placeholder: '••••' });
  const err = el('div', { class: 'error' });
  const box = el('div', { id: 'pinlock' }, el('div', { class: 'box' },
    el('h2', { style: 'margin:0;color:var(--red-dark)' }, 'FlarChat gesperrt'),
    el('p', { class: 'muted' }, 'PIN eingeben'),
    input, err,
    el('button', { class: 'link-btn', onclick: () => onForgot && onForgot() }, 'PIN vergessen? Abmelden')));
  document.body.append(box);
  input.focus();
  input.addEventListener('input', async () => {
    err.textContent = '';
    if (!/^\d{4,6}$/.test(input.value)) return;
    if (await checkPin(input.value)) box.remove();
    else if (input.value.length === 6) { err.textContent = 'Falsche PIN.'; input.value = ''; }
  });
  input.addEventListener('keydown', async e => {
    if (e.key !== 'Enter') return;
    if (await checkPin(input.value)) box.remove();
    else { err.textContent = 'Falsche PIN.'; input.value = ''; }
  });
}

// Sperrt beim Start und beim Wiederöffnen der App (nach kurzer Abwesenheit)
export function initPinLock(onForgot) {
  lockNow(onForgot);
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) hiddenAt = Date.now();
    else if (hiddenAt && Date.now() - hiddenAt > AWAY_MS) lockNow(onForgot);
  });
}
