import { sb, state, el, nameHtml, esc, fmtTime, toast, call, openModal } from './core.js';

let listEl = null;
let items = [];
let peers = new Map();
let query = '';
let activeId = null;
let timer = null;

export function initial(name) { return (String(name || '?').trim()[0] || '?').toUpperCase(); }

const MUTE_KEY = 'fc_muted_chats';
const readMuted = () => { try { return new Set(JSON.parse(localStorage.getItem(MUTE_KEY) || '[]')); } catch { return new Set(); } };
export function isMuted(id) { return readMuted().has(id); }
export function toggleMute(id) {
  const set = readMuted();
  const now = !set.has(id);
  if (now) set.add(id); else set.delete(id);
  localStorage.setItem(MUTE_KEY, JSON.stringify([...set]));
  render();
  return now;
}

let audioCtx = null;
function beep() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.08, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.25);
    o.connect(g); g.connect(audioCtx.destination);
    o.start(); o.stop(audioCtx.currentTime + 0.25);
  } catch { /* Ton nicht möglich */ }
}

// Neue Nachrichten in anderen Chats: Ton, außer der Chat ist stumm
let inbox = null;
function listenInbox() {
  if (inbox) return;
  inbox = sb.channel('inbox:' + state.me.id).on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, p => {
    const m = p.new;
    if (m.sender_id === state.me?.id) return;
    refreshSoon();
    const looking = m.chat_id === activeId && !document.hidden;
    if (!looking && !isMuted(m.chat_id)) beep();
  }).subscribe();
}

export function mountChatList(list, searchInput) {
  listEl = list;
  listenInbox();
  searchInput.addEventListener('input', () => { query = searchInput.value.trim().toLowerCase(); render(); });
  return refreshChatList();
}

export function setActiveChat(id) {
  activeId = id;
  render();
}

export function refreshSoon() {
  clearTimeout(timer);
  timer = setTimeout(refreshChatList, 300);
}

export async function refreshChatList() {
  if (!listEl) return;
  const { data, error } = await sb.from('chat_overview').select('*');
  if (error) { listEl.replaceChildren(el('div', { class: 'empty' }, 'Chats konnten nicht geladen werden.')); return; }
  items = data || [];
  const ids = [...new Set(items.map(c => c.peer_user_id).filter(Boolean))];
  if (ids.length) {
    const r = await sb.from('profiles_public').select('*').in('id', ids);
    peers = new Map((r.data || []).map(p => [p.id, p]));
  }
  render();
}

function title(c) {
  if (c.type === 'direct') {
    const p = peers.get(c.peer_user_id);
    return { html: p ? nameHtml(p) : esc(c.name || 'Chat'), text: p ? (p.display_name || p.username) : (c.name || 'Chat') };
  }
  const t = c.name || 'Gruppe';
  return { html: esc(t) + (c.verified ? ' <span class="verified" title="Verifiziert">✔</span>' : ''), text: t };
}

function render() {
  if (!listEl) return;
  const sorted = [...items].sort((a, b) => new Date(b.last_message_at || 0) - new Date(a.last_message_at || 0));
  const shown = sorted.filter(c => !query || title(c).text.toLowerCase().includes(query)
    || (c.last_message_body || '').toLowerCase().includes(query));
  if (!shown.length) {
    listEl.replaceChildren(el('div', { class: 'empty' }, items.length ? 'Keine Treffer.' : 'Noch keine Chats. Tippe oben auf ＋, um einen zu starten.'));
    return;
  }
  listEl.replaceChildren(...shown.map(c => {
    const t = title(c);
    const nameEl = el('span', { class: 'chat-name' });
    nameEl.innerHTML = t.html;
    const unread = c.unread_count > 0;
    const muted = isMuted(c.chat_id);
    const last = c.last_message_body === '' || c.last_message_body == null
      ? (c.last_message_at ? '📷 Bild' : '') : c.last_message_body;
    const prefix = c.type === 'group' && c.last_message_sender && c.last_message_sender === state.me?.id ? 'Du: ' : '';
    return el('div', { class: 'chat-item' + (c.chat_id === activeId ? ' active' : ''), onclick: () => { location.hash = '#/chat/' + c.chat_id; } },
      el('div', { class: 'avatar' }, initial(t.text)),
      el('div', { class: 'chat-main' },
        el('div', { class: 'chat-line' }, nameEl,
          el('span', { class: 'chat-time' + (unread ? ' unread' : '') }, c.last_message_at ? fmtTime(c.last_message_at) : '')),
        el('div', { class: 'chat-line' },
          el('span', { class: 'chat-last' }, prefix + last),
          unread ? el('span', { class: 'badge' + (muted ? ' muted' : '') }, c.unread_count > 99 ? '99+' : c.unread_count) : (muted ? el('span', { class: 'mute-icon', title: 'Stumm' }, '🔕') : ''))));
  }));
}

export function openNewChat() {
  const m = openModal('Neuer Chat', el('div', { class: 'menu-list' },
    el('button', { onclick: () => { m.close(); newGroup(); } }, '👥 Neue Gruppe'),
    el('button', { onclick: () => { m.close(); newDirect(); } }, '💬 Neuer Chat mit Benutzer'),
    el('button', { onclick: async () => { m.close(); try { (await import('./features/invite.js')).openJoin(); } catch (e) { toast('Nicht verfügbar.'); } } }, '🔑 Code eingeben / QR scannen')));
}

function newGroup() {
  const name = el('input', { type: 'text', maxlength: '60', placeholder: 'Gruppenname' });
  const err = el('div', { class: 'error' });
  const btn = el('button', { class: 'btn', onclick: async () => {
    if (!name.value.trim()) { err.textContent = 'Bitte einen Namen eingeben.'; return; }
    btn.disabled = true;
    try {
      const id = await call('create_group', { p_name: name.value.trim() });
      m.close();
      await refreshChatList();
      location.hash = '#/chat/' + id;
    } catch (e) { err.textContent = e.message; btn.disabled = false; }
  } }, 'Gruppe erstellen');
  const m = openModal('Neue Gruppe', el('div', {}, name, err, el('div', { class: 'row end' }, btn)));
  name.focus();
}

function newDirect() {
  const input = el('input', { type: 'search', placeholder: 'Benutzername suchen (mind. 2 Zeichen)' });
  const res = el('div', { style: 'margin-top:8px' });
  let t;
  input.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(async () => {
      const q = input.value.trim().toLowerCase();
      if (q.length < 2) { res.replaceChildren(); return; }
      try {
        const users = (await call('find_users', { p_query: q })) || [];
        const others = users.filter(u => u.id !== state.me.id);
        res.replaceChildren(...(others.length ? others.map(u => {
          const n = el('div', { style: 'flex:1;min-width:0' });
          n.innerHTML = nameHtml(u) + ` <span class="muted small">@${esc(u.username)}</span>`;
          return el('div', { class: 'user-hit', onclick: async () => {
            try {
              const id = await call('start_direct', { p_user_id: u.id });
              m.close();
              await refreshChatList();
              location.hash = '#/chat/' + id;
            } catch (e) { toast(e.message); }
          } }, el('div', { class: 'avatar sm' }, initial(u.display_name || u.username)), n);
        }) : [el('div', { class: 'empty' }, 'Niemand gefunden.')]));
      } catch (e) { res.replaceChildren(el('div', { class: 'error' }, e.message)); }
    }, 300);
  });
  const m = openModal('Neuer Chat', el('div', {}, input, res));
  input.focus();
}
