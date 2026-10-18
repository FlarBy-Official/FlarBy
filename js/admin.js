import { sb, state, el, esc, toast, call, nameHtml } from './core.js';

let root = document.getElementById('admin-root');
let overlay = null;

const banner = () => el('div', { class: 'admin-banner' }, 'Schreibgeschützter Admin-Zugang – alle Zugriffe werden protokolliert');
const fmt = iso => new Date(iso).toLocaleString('de-DE');

function backBtn() {
  return overlay ? el('button', { class: 'btn', onclick: closeAdmin }, 'Schließen') : el('a', { class: 'btn', href: './' }, 'Zur App');
}

function closeAdmin() {
  overlay?.remove();
  overlay = null;
  root = null;
}

// Öffnet den Admin-Bereich als Vollbild-Ansicht innerhalb der App
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
  mainScreen();
}

function mainScreen() {
  const view = el('div', { class: 'admin-view' });
  const tabs = el('div', { class: 'tabs' });
  screen(el('div', { class: 'row' }, el('h2', { class: 'grow' }, 'Admin-Bereich'), overlay ? el('button', { class: 'btn small', onclick: closeAdmin }, 'Schließen') : null), tabs, view);

  const show = id => {
    tabs.replaceChildren(...[['chats', 'Chats'], ['audit', 'Audit-Log']].map(([k, l]) => el('button', { class: 'tab' + (k === id ? ' active' : ''), onclick: () => show(k) }, l)));
    view.replaceChildren(el('p', { class: 'muted' }, 'Lade …'));
    (id === 'chats' ? chatsView : auditView)(view).catch(e => view.replaceChildren(el('p', { class: 'error' }, e.message)));
  };
  show('chats');
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
    toast(e.message); back();
  }
}

async function auditView(view) {
  const rows = (await call('admin_audit_log', { p_limit: 200 })) || [];
  const t = el('table', { class: 'audit' }, el('thead', {}, el('tr', {}, ['Zeit', 'Aktion', 'Ziel', 'Details'].map(h => el('th', {}, h)))),
    el('tbody', {}, rows.map(r => el('tr', {}, el('td', {}, fmt(r.created_at)), el('td', {}, r.action), el('td', {}, r.target ?? ''), el('td', {}, r.details ? JSON.stringify(r.details) : '')))));
  view.replaceChildren(rows.length ? el('div', { class: 'table-scroll' }, t) : el('p', { class: 'muted' }, 'Leer.'));
}

if (root) init();
