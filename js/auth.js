import { sb, el, call, toast } from './core.js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const NOTICE = 'Hinweis: Der Betreiber von FlarChat ist Cool';
const USER_RE = /^[a-z0-9_]{3,20}$/;

export const toEmail = u => `${u.trim().toLowerCase()}@flarchat.local`;

function deviceId() {
  let d = localStorage.getItem('fc_device');
  if (!d) { d = crypto.randomUUID(); localStorage.setItem('fc_device', d); }
  return d;
}

async function fn(name, body) {
  let res;
  try {
    res = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
      body: JSON.stringify(body),
    });
  } catch { throw new Error('Keine Verbindung zum Server.'); }
  let data = null;
  try { data = await res.json(); } catch { /* leer */ }
  if (!data || !data.ok) throw new Error((data && data.error) || 'Anfrage fehlgeschlagen.');
  return data;
}

async function login(username, password) {
  const { error } = await sb.auth.signInWithPassword({ email: toEmail(username), password });
  if (error) throw new Error('Benutzername oder Passwort ist falsch.');
}

function field(label, attrs) {
  const input = el('input', attrs);
  return { input, node: el('label', { class: 'field' }, label, input) };
}

function busy(btn, fnc) {
  return async () => {
    btn.disabled = true;
    try { await fnc(); } finally { btn.disabled = false; }
  };
}

function recoveryView(code, onContinue) {
  return el('div', {},
    el('h2', { style: 'margin:0 0 4px' }, 'Dein Wiederherstellungscode'),
    el('div', { class: 'recovery-code' }, code),
    el('p', { class: 'error' }, 'Gut aufschreiben! Er wird nur jetzt angezeigt und wird gebraucht, falls du dein Passwort vergisst.'),
    el('button', { class: 'btn ghost block', onclick: () => navigator.clipboard?.writeText(code).then(() => toast('Kopiert')) }, 'Code kopieren'),
    el('div', { style: 'height:8px' }),
    el('button', { class: 'btn block', onclick: onContinue }, 'Ich habe ihn aufgeschrieben – weiter'));
}

// Zeigt Login/Registrieren/Passwort-vergessen in `root`. onLogin() wird nach erfolgreicher Anmeldung gerufen.
export function renderAuth(root, { onLogin, notice } = {}) {
  root.replaceChildren();
  const body = el('div');
  const card = el('div', { class: 'auth-card' },
    el('div', { class: 'auth-logo' }, el('img', { src: 'icons/icon.svg', alt: '' }), el('h1', {}, 'FlarChat')),
    body);
  root.append(el('div', { class: 'auth-wrap' }, card));
  if (notice) body.append(el('div', { class: 'error' }, notice));

  const tabs = (active) => el('div', { class: 'tabs' },
    el('button', { class: active === 'login' ? 'on' : '', onclick: showLogin }, 'Anmelden'),
    el('button', { class: active === 'register' ? 'on' : '', onclick: showRegister }, 'Registrieren'));
  const show = (...nodes) => body.replaceChildren(...nodes);

  function showLogin() {
    const u = field('Benutzername', { type: 'text', autocomplete: 'username', autocapitalize: 'none', autocorrect: 'off' });
    const p = field('Passwort', { type: 'password', autocomplete: 'current-password' });
    const err = el('div', { class: 'error' });
    const btn = el('button', { class: 'btn block', type: 'submit' }, 'Anmelden');
    const form = el('form', {}, u.node, p.node, err, btn,
      el('p', { style: 'text-align:center' }, el('button', { type: 'button', class: 'link-btn', onclick: showForgot }, 'Passwort vergessen?')));
    form.addEventListener('submit', e => {
      e.preventDefault();
      busy(btn, async () => {
        err.textContent = '';
        try { await login(u.input.value, p.input.value); onLogin && onLogin(); }
        catch (x) { err.textContent = x.message; }
      })();
    });
    show(tabs('login'), form);
    u.input.focus();
  }

  function showRegister() {
    const u = field('Benutzername (a–z, 0–9, _; 3–20 Zeichen)', { type: 'text', autocomplete: 'username', autocapitalize: 'none', maxlength: '20' });
    const p = field('Passwort (mind. 8 Zeichen)', { type: 'password', autocomplete: 'new-password' });
    const err = el('div', { class: 'error' });
    const btn = el('button', { class: 'btn block', type: 'submit' }, 'Registrieren');
    const form = el('form', {}, u.node, p.node,
      el('div', { class: 'notice-big' }, NOTICE), err, btn);
    form.addEventListener('submit', e => {
      e.preventDefault();
      busy(btn, async () => {
        err.textContent = '';
        const username = u.input.value.trim().toLowerCase();
        if (!USER_RE.test(username)) { err.textContent = 'Ungültiger Benutzername.'; return; }
        if (p.input.value.length < 8) { err.textContent = 'Das Passwort muss mindestens 8 Zeichen haben.'; return; }
        try {
          const r = await fn('register', { username, password: p.input.value });
          show(recoveryView(r.recovery_code, async () => {
            try { await login(username, p.input.value); onLogin && onLogin(); }
            catch (x) { showLogin(); toast(x.message); }
          }));
        } catch (x) { err.textContent = x.message; }
      })();
    });
    show(tabs('register'), form);
    u.input.focus();
  }

  function showForgot() {
    const wrap = el('div', {},
      el('h2', { style: 'margin:0 0 8px' }, 'Passwort vergessen'),
      el('button', { class: 'btn block', onclick: showRecovery }, 'Mit Wiederherstellungscode'),
      el('div', { style: 'height:8px' }),
      el('button', { class: 'btn ghost block', onclick: showTicket }, 'Ich habe keinen Code – Anfrage an das Team'),
      el('p', {}, el('button', { class: 'link-btn', onclick: showLogin }, '← Zurück')));
    show(wrap);
  }

  function showRecovery() {
    const u = field('Benutzername', { type: 'text', autocapitalize: 'none', autocomplete: 'username' });
    const r = field('Wiederherstellungscode (XXXX-XXXX)', { type: 'text', autocapitalize: 'characters', autocomplete: 'off' });
    const p = field('Neues Passwort (mind. 8 Zeichen)', { type: 'password', autocomplete: 'new-password' });
    const err = el('div', { class: 'error' });
    const btn = el('button', { class: 'btn block', type: 'submit' }, 'Passwort zurücksetzen');
    const form = el('form', {}, el('h2', { style: 'margin:0' }, 'Mit Code zurücksetzen'), u.node, r.node, p.node, err, btn,
      el('p', {}, el('button', { type: 'button', class: 'link-btn', onclick: showForgot }, '← Zurück')));
    form.addEventListener('submit', e => {
      e.preventDefault();
      busy(btn, async () => {
        err.textContent = '';
        if (p.input.value.length < 8) { err.textContent = 'Das Passwort muss mindestens 8 Zeichen haben.'; return; }
        try {
          const username = u.input.value.trim().toLowerCase();
          const d = await fn('reset-with-recovery', { username, recovery_code: r.input.value.trim().toUpperCase(), new_password: p.input.value });
          show(el('p', {}, 'Dein Passwort wurde geändert. Hier ist dein NEUER Wiederherstellungscode:'),
            recoveryView(d.recovery_code, async () => {
              try { await login(username, p.input.value); onLogin && onLogin(); }
              catch (x) { showLogin(); toast(x.message); }
            }));
        } catch (x) { err.textContent = x.message; }
      })();
    });
    show(form);
  }

  function showTicket() {
    const u = field('Benutzername', { type: 'text', autocapitalize: 'none' });
    const m = el('textarea', { rows: '4', maxlength: '500', placeholder: 'Kurze Nachricht an das Team' });
    const err = el('div', { class: 'error' });
    const btn = el('button', { class: 'btn block', type: 'submit' }, 'Anfrage senden');
    const form = el('form', {}, el('h2', { style: 'margin:0' }, 'Anfrage an das Team'), u.node,
      el('label', { class: 'field' }, 'Nachricht', m), err, btn,
      el('p', {}, el('button', { type: 'button', class: 'link-btn', onclick: showForgot }, '← Zurück')));
    form.addEventListener('submit', e => {
      e.preventDefault();
      busy(btn, async () => {
        err.textContent = '';
        try {
          await call('submit_ticket', { p_username: u.input.value.trim().toLowerCase(), p_message: m.value.trim(), p_device_id: deviceId() });
          show(el('p', {}, 'Danke! Deine Anfrage wurde gesendet. Ein Team-Mitglied meldet sich mit einem temporären Passwort.'),
            el('button', { class: 'btn block', onclick: showLogin }, 'Zurück zur Anmeldung'));
        } catch (x) { err.textContent = x.message; }
      })();
    });
    show(form);
  }

  showLogin();
}

// Erzwungener Passwortwechsel; resolved nach Erfolg
export function forcePasswordChange(root) {
  return new Promise(resolve => {
    root.replaceChildren();
    const p1 = field('Neues Passwort (mind. 8 Zeichen)', { type: 'password', autocomplete: 'new-password' });
    const p2 = field('Neues Passwort wiederholen', { type: 'password', autocomplete: 'new-password' });
    const err = el('div', { class: 'error' });
    const btn = el('button', { class: 'btn block', type: 'submit' }, 'Passwort speichern');
    const form = el('form', {}, el('h2', { style: 'margin:0 0 8px' }, 'Neues Passwort festlegen'),
      el('p', { class: 'muted' }, 'Du hast ein temporäres Passwort erhalten. Bitte wähle jetzt ein eigenes.'),
      p1.node, p2.node, err, btn,
      el('p', {}, el('button', { type: 'button', class: 'link-btn', onclick: () => sb.auth.signOut() }, 'Abmelden')));
    form.addEventListener('submit', e => {
      e.preventDefault();
      busy(btn, async () => {
        err.textContent = '';
        if (p1.input.value.length < 8) { err.textContent = 'Das Passwort muss mindestens 8 Zeichen haben.'; return; }
        if (p1.input.value !== p2.input.value) { err.textContent = 'Die Passwörter stimmen nicht überein.'; return; }
        try {
          const { error } = await sb.auth.updateUser({ password: p1.input.value });
          if (error) throw new Error(error.message);
          await call('clear_must_change_password');
          resolve();
        } catch (x) { err.textContent = x.message; }
      })();
    });
    root.append(el('div', { class: 'auth-wrap' }, el('div', { class: 'auth-card' }, form)));
    p1.input.focus();
  });
}
