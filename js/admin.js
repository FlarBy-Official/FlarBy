import { sb, state, el, esc, toast, call, nameHtml } from './core.js';

let root = document.getElementById('admin-root');
let unlockedUntil = null, timer = null, overlay = null;

const banner = () => el('div', { class: 'admin-banner' }, 'Schreibgeschützter Admin-Zugang – alle Zugriffe werden protokolliert');
const fmt = iso => new Date(iso).toLocaleString('de-DE');

function backBtn() {
  return overlay ? el('button', { class: 'btn', onclick: closeAdmin }, 'Schließen') : el('a', { class: 'btn', href: './' }, 'Zur App');
}

function closeAdmin() {
  clearInterval(timer);
  unlockedUntil = null;
  overlay?.remove();
  overlay = null;
  root = null;
}

// Öffnet den Admin-Bereich als Vollbild-Ansicht innerhalb der App (PIN wird immer abgefragt)
export function openAdmin() {
  if (overlay) return;
  root = el('div', { id: 'admin-root' });
  overlay = el('div', { class: 'admin-overlay' }, root);
  document.body.append(overlay);
  init();
}

function screen(...nodes) { root?.replaceChildren(banner(), el('div', { class: 'admin-wrap' }, ...nodes)); }

async function init() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return screen(el('h2', {}, 'Admin-Bereich'), el('p', {}, 'Bitte zuerst in FlarChat anmelden.'), backBtn());
  state.me = session.user;
  try {
    const p = await call('my_profile');
    state.profile = Array.isArray(p) ? p[0] : p;
  } catch (e) { return screen(el('p', { class: 'error' }, e.message)); }
  if (state.profile?.global_role !== 'owner') return screen(el('h2', {}, 'Kein Zugriff'), el('p', {}, 'Dieser Bereich ist nur für den Owner.'), backBtn());
  pinScreen();
}

function pinInput(ph) {
  const i = el('input', { type: 'password', inputmode: 'numeric', autocomplete: 'off', maxlength: 12, placeholder: ph });
  i.addEventListener('input', () => { i.value = i.value.replace(/\D/g, ''); });
  return i;
}

function pinScreen(msg) {
  const pin = pinInput('Admin-PIN');
  const go = async () => {
    try {
      const res = await call('admin_unlock', { p_pin: pin.value });
      if (!res) throw new Error('PIN falsch oder vorübergehend gesperrt (5 Fehlversuche = 15 Minuten Sperre).');
      unlockedUntil = new Date(res);
      pin.value = '';
      mainScreen();
    } catch (e) { toast(e.message); pin.value = ''; }
  };
  pin.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });

  const oldP = pinInput('Alte PIN (leer bei erster PIN)'), newP = pinInput('Neue PIN (8–12 Ziffern)');
  screen(el('h2', {}, 'Admin-Bereich'), msg ? el('p', {}, msg) : null,
    el('div', { class: 'row' }, pin, el('button', { class: 'btn', onclick: go }, 'Entsperren')),
    el('details', {}, el('summary', {}, 'PIN setzen / ändern'),
      el('p', { class: 'muted' }, 'Noch keine PIN? Setze sie hier (altes Feld leer lassen).'),
      oldP, newP,
      el('button', { class: 'btn ghost', onclick: async () => {
        try {
          const ok = await call('admin_set_pin', { p_old: oldP.value || null, p_new: newP.value });
          if (!ok) throw new Error('Alte PIN falsch oder gesperrt.');
          toast('PIN gespeichert.'); oldP.value = newP.value = '';
        }
        catch (e) { toast(e.message); }
      } }, 'PIN speichern')));
  pin.focus();
}

function mainScreen() {
  const countdown = el('span', { class: 'countdown' });
  const view = el('div', { class: 'admin-view' });
  const tabs = el('div', { class: 'tabs' });
  screen(el('div', { class: 'row' }, el('h2', { class: 'grow' }, 'Admin-Bereich'), el('span', {}, 'Entsperrt noch: ', countdown),
    el('button', { class: 'btn ghost small', onclick: lock }, 'Sperren'), overlay ? el('button', { class: 'btn small', onclick: closeAdmin }, 'Schließen') : null), tabs, view);

  clearInterval(timer);
  const tick = () => {
    const s = Math.max(0, Math.round((unlockedUntil - Date.now()) / 1000));
    countdown.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    if (s <= 0) lock('Entsperrung abgelaufen – bitte PIN erneut eingeben.');
  };
  tick(); timer = setInterval(tick, 1000);

  const show = id => {
    tabs.replaceChildren(...[['chats', 'Chats'], ['audit', 'Audit-Log']].map(([k, l]) => el('button', { class: 'tab' + (k === id ? ' active' : ''), onclick: () => show(k) }, l)));
    view.replaceChildren(el('p', { class: 'muted' }, 'Lade …'));
    (id === 'chats' ? chatsView : auditView)(view).catch(e => {
      if (/PIN|entsperr|gesperrt/i.test(e.message)) lock(e.message);
      else view.replaceChildren(el('p', { class: 'error' }, e.message));
    });
  };
  show('chats');
}

function lock(msg) {
  clearInterval(timer);
  pinScreen(typeof msg === 'string' ? msg : null);
}

async function chatsView(view) {
  const chats = (await call('admin_list_chats')) || [];
  const list = el('div', { class: 'admin-chats' }, chats.length ? chats.map(c =>
    el('button', { class: 'list-row link', onclick: () => readChat(view, c, () => chatsView(view).catch(e => toast(e.message))) },
      el('span', { class: 'grow' }, c.name || `Direktchat ${String(c.id).slice(0, 8)}`),
      el('span', { class: 'muted small' }, c.type === 'group' ? 'Gruppe' : 'Direkt'))) : el('p', { class: 'muted' }, 'Keine Chats.'));
  view.replaceChildren(list);
}

async function readChat(view, chat, back) {
  view.replaceChildren(el('p', { class: 'muted' }, 'Lade …'));
  try {
    const msgs = ((await call('admin_chat_messages', { p_chat_id: chat.id })) || []).slice().sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    const ids = [...new Set(msgs.map(m => m.sender_id))];
    const { data } = ids.length ? await sb.from('profiles_public').select('*').in('id', ids) : { data: [] };
    const pm = Object.fromEntries((data || []).map(p => [p.id, p]));
    const list = el('div', { class: 'admin-msgs' });
    for (const m of msgs) {
      const d = el('div', { class: 'admin-msg' + (m.deleted_at ? ' deleted' : '') });
      const edits = Array.isArray(m.edits) ? m.edits : [];
      d.innerHTML = `<div class="small">${nameHtml(pm[m.sender_id]) || esc(m.sender_id)} <span class="muted">${esc(fmt(m.created_at))}</span>${m.deleted_at ? ' <span class="status status-widerrufen">gelöscht ' + esc(fmt(m.deleted_at)) + '</span>' : ''}${edits.length ? ' <span class="status status-abgelaufen">bearbeitet</span>' : ''}</div>
        <div>${esc(m.body || '')}${m.media_path ? ' <span class="muted">[Bild]</span>' : ''}</div>
        ${edits.length ? '<ul class="edits">' + edits.map(e => `<li><span class="muted small">${esc(fmt(e.edited_at))}:</span> ${esc(e.old_body)}</li>`).join('') + '</ul>' : ''}`;
      list.append(d);
    }
    view.replaceChildren(el('div', { class: 'row' }, el('button', { class: 'btn ghost small', onclick: back }, '← Zurück'), el('strong', {}, chat.name || 'Direktchat')),
      msgs.length ? list : el('p', { class: 'muted' }, 'Keine Nachrichten.'));
  } catch (e) {
    if (/PIN|entsperr|gesperrt/i.test(e.message)) lock(e.message); else { toast(e.message); back(); }
  }
}

async function auditView(view) {
  const rows = (await call('admin_audit_log', { p_limit: 200 })) || [];
  const t = el('table', { class: 'audit' }, el('thead', {}, el('tr', {}, ['Zeit', 'Aktion', 'Ziel', 'Details'].map(h => el('th', {}, h)))),
    el('tbody', {}, rows.map(r => el('tr', {}, el('td', {}, fmt(r.created_at)), el('td', {}, r.action), el('td', {}, r.target ?? ''), el('td', {}, r.details ? JSON.stringify(r.details) : '')))));
  view.replaceChildren(rows.length ? el('div', { class: 'table-scroll' }, t) : el('p', { class: 'muted' }, 'Leer.'));
}

if (root) init();
