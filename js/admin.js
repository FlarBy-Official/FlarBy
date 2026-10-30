import { sb, state, el, esc, toast, call, nameHtml, confirmDialog } from './core.js';
import { signedUrl } from './media.js';

let root = document.getElementById('admin-root');
let overlay = null;

const banner = () => el('div', { class: 'admin-banner' }, 'Admin-Panel – Chat-Zugriffe werden protokolliert');
const fmt = iso => new Date(iso).toLocaleString('de-DE');

function backBtn() {
  return overlay ? el('button', { class: 'btn', onclick: closeAdmin }, '← Zurück') : el('a', { class: 'btn', href: './' }, 'Zur App');
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
  overlay = el('div', { class: 'admin-overlay' }, root,
    el('button', { class: 'admin-home', onclick: closeAdmin }, '← Zurück'));
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
  screen(el('div', { class: 'row' }, overlay ? null : el('a', { class: 'btn small', href: './' }, '← Zurück'), el('h2', { class: 'grow' }, 'Admin-Panel')), tabs, view);

  const show = id => {
    tabs.replaceChildren(...[['stats', 'Statistik'], ['chats', 'Chats'], ['activity', 'Aktivität'], ['codes', 'Codes'], ['announce', 'Ansage'], ['words', 'Wörter'], ['reports', 'Meldungen'], ['tickets', 'Tickets'], ['support', 'Support'], ['users', 'Nutzer'], ['age', 'Alter'], ['errors', 'Fehler'], ['audit', 'Audit-Log']].map(([k, l]) => el('button', { class: 'tab' + (k === id ? ' active' : ''), onclick: () => show(k) }, l)));
    view.replaceChildren(el('p', { class: 'muted' }, 'Lade …'));
    const load = async () => {
      if (id === 'chats') return chatsView(view);
      if (['stats', 'activity', 'codes', 'announce', 'words'].includes(id)) {
        const x = await import('./features/adminExtra.js');
        return ({ stats: x.statsView, activity: x.activityView, codes: x.codesView, announce: x.announceView, words: x.wordsView })[id](view);
      }
      if (id === 'audit') return auditView(view);
      if (id === 'support') return supportView(view);
      const t = await import('./features/team.js');
      return ({ reports: t.tabReports, tickets: t.tabTickets, users: t.tabUsers, age: t.tabAge, errors: t.tabErrors })[id](view);
    };
    load().catch(e => view.replaceChildren(el('p', { class: 'error' }, e.message)));
  };
  show('stats');
}

async function chatsView(view) {
  const chats = (await call('admin_list_chats')) || [];
  const title = c => c.name || `Direktchat ${String(c.id).slice(0, 8)}`;
  const list = el('div', { class: 'admin-chats' });
  const draw = q => list.replaceChildren(...(chats.filter(c => !q || `${title(c)} ${c.members || ''}`.toLowerCase().includes(q)).map(c =>
    el('button', { class: 'list-row link', onclick: () => readChat(view, c, () => chatsView(view).catch(e => toast(e.message))) },
      el('span', { class: 'grow' }, title(c), el('span', { class: 'muted small' }, c.members ? ' · ' + c.members : '')),
      el('span', { class: 'muted small' }, c.type === 'group' ? 'Gruppe' : c.type === 'ticket' ? 'Ticket' : 'Direkt')))));
  draw('');
  const i = el('input', { type: 'search', placeholder: 'Chat oder Nutzer suchen …', style: 'width:100%;margin:6px 0' });
  i.addEventListener('input', () => draw(i.value.trim().toLowerCase()));
  view.replaceChildren(i, chats.length ? list : el('p', { class: 'muted' }, 'Keine Chats.'));
}

async function supportView(view) {
  const rows = (await call('admin_list_support_tickets')) || [];
  const num = n => '#' + String(n).padStart(4, '0');
  const list = el('div', {}, ...(rows.length ? rows.map(t => {
    const state = t.status === 'open' ? 'offen' : 'geschlossen' + (t.closed_by_username ? ' von @' + t.closed_by_username : '');
    return el('button', { class: 'list-row link wrap', onclick: () => readChat(view, { id: t.chat_id, name: t.name }, () => supportView(view).catch(e => toast(e.message))) },
      el('span', { class: 'grow' }, `${num(t.number)} · ${t.display_name} `, el('span', { class: 'muted small' }, `@${t.username} · ${t.reason}`)),
      el('span', { class: 'status ' + (t.status === 'open' ? 'status-aktiv' : 'status-abgelaufen') }, state),
      t.user_deleted_at ? el('span', { class: 'status status-widerrufen' }, 'vom Nutzer gelöscht') : null,
      el('span', { class: 'muted small' }, `${fmt(t.created_at)} · ${t.message_count} Nachr.`));
  }) : [el('p', { class: 'muted' }, 'Noch keine Support-Tickets.')]));
  view.replaceChildren(list);
}

function systemComposer(view, chat, back) {
  const ta = el('textarea', { rows: '2', maxlength: '500', placeholder: 'Systemnachricht schreiben …', style: 'width:100%' });
  const send = el('button', { class: 'btn', onclick: async () => {
    if (!ta.value.trim()) return;
    send.disabled = true;
    try { await call('admin_send_system_message', { p_chat_id: chat.id, p_body: ta.value }); toast('Systemnachricht gesendet.'); readChat(view, chat, back); } catch (e) { toast(e.message); send.disabled = false; }
  } }, '📢 Als SYSTEM senden');
  return el('div', { class: 'admin-msg' }, el('strong', {}, 'Systemnachricht an alle in diesem Chat'), ta, el('div', { class: 'row end' }, send));
}

async function exportChat(chat) {
  const all = [];
  let before = new Date().toISOString();
  for (;;) {
    const page = (await call('admin_chat_messages', { p_chat_id: chat.id, p_before: before, p_limit: 500 })) || [];
    all.push(...page);
    if (page.length < 500) break;
    before = page[page.length - 1].created_at;
  }
  all.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  const text = all.map(m => `[${fmt(m.created_at)}] ${m.sender_username || m.sender_id}: ${m.body || ''}${m.media_path ? ' [Bild]' : ''}${m.deleted_at ? ' (gelöscht)' : ''}`).join('\n');
  const a = el('a', { href: URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' })), download: `chat-${String(chat.name || chat.id).replace(/[^\w-]+/g, '_')}.txt` });
  document.body.append(a); a.click(); a.remove();
  URL.revokeObjectURL(a.href);
}

async function deleteChat(chat) {
  const paths = (await call('admin_chat_media', { p_chat_id: chat.id })) || [];
  await call('admin_delete_chat', { p_chat_id: chat.id });
  for (let i = 0; i < paths.length; i += 100) await sb.storage.from('media').remove(paths.slice(i, i + 100));
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
      d.innerHTML = `<div class="small">${nameHtml(pm[m.sender_id]) || esc(m.sender_id)} <span class="muted">${esc(fmt(m.created_at))}</span>${m.deleted_at ? ' <span class="status status-widerrufen">gelöscht ' + esc(fmt(m.deleted_at)) + '</span>' : ''}${edits.length ? ' <span class="status status-abgelaufen">bearbeitet</span>' : ''}${m.is_system ? ' <span class="status status-aktiv">SYSTEM</span>' : ''}</div>
        <div>${esc(m.body || '')}${m.media_path ? ' <span class="muted media-note">🖼 Bild wird geladen …</span>' : ''}</div>
        ${edits.length ? '<ul class="edits">' + edits.map(e => `<li><span class="muted small">${esc(fmt(e.edited_at))}:</span> ${esc(e.old_body)}</li>`).join('') + '</ul>' : ''}`;
      if (m.is_system && !m.deleted_at) d.append(el('button', { class: 'btn ghost small', onclick: async () => {
        if (!await confirmDialog('Systemnachricht löschen?', 'Löschen')) return;
        try { await call('admin_delete_system_message', { p_message_id: m.id }); toast('Gelöscht.'); readChat(view, chat, back); } catch (e) { toast(e.message); }
      } }, '🗑 Löschen'));
      if (!m.deleted_at) d.append(el('button', { class: 'btn ghost small', onclick: async () => {
        try { await call('pin_message', { p_chat_id: chat.id, p_message_id: m.id }); toast('Nachricht angepinnt.'); } catch (e) { toast(e.message); }
      } }, '📌 Anpinnen'));
      list.append(d);
      if (m.media_path) {
        const note = d.querySelector('.media-note');
        const fail = msg => { if (note) note.textContent = '🖼 Bild-Fehler: ' + msg; };
        const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('Zeitüberschreitung – keine Antwort von Supabase')), 10000));
        Promise.race([signedUrl(m.media_path), timeout]).then(url => {
          if (note) note.remove();
          const img = el('img', { src: url, alt: 'Bild', style: 'max-width:240px;max-height:240px;border-radius:8px;display:block;margin-top:6px' });
          img.onerror = () => d.append(el('p', { class: 'error small' }, 'Bild-Fehler: Datei konnte nicht angezeigt werden.'));
          d.append(el('a', { href: url, target: '_blank', rel: 'noopener' }, img));
        }).catch(e => fail(e.message || 'unbekannt'));
      }
    }
    const tools = el('div', { class: 'row wrap' },
      el('button', { class: 'btn ghost small', onclick: async () => { try { await exportChat(chat); toast('Datei gespeichert.'); } catch (e) { toast(e.message); } } }, '💾 Exportieren'),
      el('button', { class: 'btn danger small', onclick: async () => {
        if (!await confirmDialog('Diesen Chat mit allen Nachrichten und Bildern für immer löschen?', 'Löschen')) return;
        try { await deleteChat(chat); toast('Chat gelöscht.'); back(); } catch (e) { toast(e.message); }
      } }, '🗑 Chat löschen'));
    view.replaceChildren(el('div', { class: 'row' }, el('button', { class: 'btn ghost small', onclick: back }, '← Zurück'), el('strong', {}, chat.name || 'Direktchat')), tools,
      msgs.length ? list : el('p', { class: 'muted' }, 'Keine Nachrichten.'), systemComposer(view, chat, back));
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
