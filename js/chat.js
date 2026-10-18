import { sb, state, el, esc, nameHtml, toast, call, openModal, confirmDialog } from './core.js';
import { uploadImage, signedUrl } from './media.js';
import { refreshSoon, initial } from './chatlist.js';

const EDIT_MS = 3 * 24 * 3600 * 1000;
const PAGE = 60;

let pane = null;
let cur = null; // aktueller Chat-Zustand

const profCache = new Map();
async function loadProfiles(ids) {
  const miss = [...new Set(ids)].filter(i => i && !profCache.has(i));
  if (miss.length) {
    const { data } = await sb.from('profiles_public').select('*').in('id', miss);
    (data || []).forEach(p => profCache.set(p.id, p));
    miss.forEach(i => { if (!profCache.has(i)) profCache.set(i, { id: i, username: 'unbekannt' }); });
  }
}

export function mountChat(container) {
  pane = container;
  showEmpty();
}

function showEmpty() {
  pane.replaceChildren(el('div', { class: 'empty-pane' },
    el('img', { src: 'icons/icon.svg', alt: '' }), el('h2', {}, 'FlarChat'),
    el('p', {}, 'Wähle links einen Chat oder starte einen neuen.')));
}

export function closeChat() {
  teardown();
  document.body.classList.remove('chat-open');
  if (pane) showEmpty();
}

function teardown() {
  if (cur) {
    if (cur.channel) sb.removeChannel(cur.channel);
    clearInterval(cur.tick);
    cur.dead = true;
  }
  cur = null;
}

function dayLabel(iso) {
  return new Date(iso).toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
}
function clock(iso) { return new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }); }

export async function openChat(chatId) {
  teardown();
  document.body.classList.add('chat-open');
  const c = cur = {
    id: chatId, msgs: [], byId: new Map(), members: new Map(), meta: null, peer: null, dead: false,
    typing: new Map(), online: new Set(), reply: null, editing: null, lastTyping: 0, oldestReached: false,
  };

  const title = el('div', { class: 't1' });
  const sub = el('div', { class: 't2' });
  const avatar = el('div', { class: 'avatar sm' }, '…');
  c.title = title; c.sub = sub; c.avatar = avatar;
  const head = el('div', { class: 'chat-head' },
    el('button', { class: 'icon-btn back-btn', 'aria-label': 'Zurück', onclick: () => { location.hash = '#/'; } }, '←'),
    avatar,
    el('div', { class: 'info', onclick: async () => {
      try { (await import('./features/chatInfo.js')).openChatInfo(chatId); } catch { toast('Chat-Info nicht verfügbar.'); }
    } }, title, sub));
  const msgsEl = el('div', { class: 'msgs' });
  c.msgsEl = msgsEl;

  const ctxBar = el('div', { class: 'ctx-bar hidden' });
  c.ctxBar = ctxBar;
  const ta = el('textarea', { rows: '1', placeholder: 'Nachricht', maxlength: '4000' });
  c.ta = ta;
  const file = el('input', { type: 'file', accept: 'image/*', class: 'hidden' });
  const sendBtn = el('button', { class: 'icon-btn send', 'aria-label': 'Senden' }, '➤');
  const composer = el('div', { class: 'composer-wrap' }, ctxBar,
    el('div', { class: 'composer' },
      el('button', { class: 'icon-btn', 'aria-label': 'Bild senden', onclick: () => file.click() }, '📎'),
      file, ta, sendBtn));
  pane.replaceChildren(head, msgsEl, composer);

  ta.addEventListener('input', () => {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
    if (Date.now() - c.lastTyping > 2500 && c.channel) {
      c.lastTyping = Date.now();
      c.channel.send({ type: 'broadcast', event: 'typing', payload: { user_id: state.me.id } });
    }
  });
  ta.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && window.matchMedia('(hover: hover)').matches) { e.preventDefault(); send(); }
  });
  sendBtn.addEventListener('click', send);
  file.addEventListener('change', async () => {
    const f = file.files[0];
    file.value = '';
    if (!f) return;
    try {
      toast('Bild wird hochgeladen …');
      const path = await uploadImage(chatId, f);
      await insertMessage({ body: '', media_path: path });
    } catch (e) { toast(e.message); }
  });

  async function send() {
    const text = ta.value.trim();
    if (!text) return;
    try {
      if (c.editing) {
        const id = c.editing.id;
        await call('edit_message', { p_message_id: id, p_body: text });
        const m = c.byId.get(id);
        if (m) { m.body = text; m.edited_at = new Date().toISOString(); }
        setContext(null, null);
        render();
      } else {
        await insertMessage({ body: text });
      }
      ta.value = ''; ta.style.height = 'auto';
    } catch (e) { toast(e.message); }
  }

  async function insertMessage({ body, media_path = null }) {
    const row = { chat_id: chatId, sender_id: state.me.id, body, media_path, reply_to: c.reply ? c.reply.id : null };
    const { data, error } = await sb.from('messages').insert(row).select().single();
    if (error) throw new Error(error.message);
    setContext(null, null);
    addMessage(data, true);
  }

  function setContext(kind, m) {
    c.reply = kind === 'reply' ? m : null;
    c.editing = kind === 'edit' ? m : null;
    if (!kind) { ctxBar.classList.add('hidden'); ctxBar.replaceChildren(); return; }
    ctxBar.classList.remove('hidden');
    ctxBar.replaceChildren(
      el('div', { class: 'txt' }, (kind === 'edit' ? '✎ Bearbeiten: ' : '↩ Antwort: ') + (m.body || '📷 Bild')),
      el('button', { class: 'icon-btn', onclick: () => { setContext(null, null); if (kind === 'edit') ta.value = ''; } }, '✕'));
    if (kind === 'edit') ta.value = m.body;
    ta.focus();
  }
  c.setContext = setContext;

  // Metadaten
  const { data: meta } = await sb.from('chat_overview').select('*').eq('chat_id', chatId).maybeSingle();
  if (c.dead) return;
  c.meta = meta || { chat_id: chatId, type: 'group', name: 'Chat' };
  if (c.meta.type === 'direct' && c.meta.peer_user_id) {
    await loadProfiles([c.meta.peer_user_id]);
    c.peer = profCache.get(c.meta.peer_user_id);
  }
  renderHead();

  await Promise.all([loadMembers(), loadMessages()]);
  if (c.dead) return;
  render(true);
  markRead();
  subscribe();
  c.tick = setInterval(() => { // abgelaufene "schreibt…"-Anzeigen entfernen
    const now = Date.now();
    let ch = false;
    for (const [k, t] of c.typing) if (now - t > 4000) { c.typing.delete(k); ch = true; }
    if (ch) renderHead();
  }, 1000);
  ta.focus();

  function renderHead() {
    const m = c.meta;
    const name = c.peer ? (c.peer.display_name || c.peer.username) : (m.name || 'Chat');
    c.avatar.textContent = initial(name);
    title.innerHTML = c.peer ? nameHtml(c.peer) : esc(m.name || 'Chat') + (m.verified ? ' <span class="verified" title="Verifiziert">✔</span>' : '');
    const typers = [...c.typing.keys()];
    if (typers.length) {
      sub.textContent = m.type === 'direct' ? 'schreibt …'
        : typers.map(id => (profCache.get(id)?.display_name || profCache.get(id)?.username || 'Jemand')).join(', ') + ' schreibt …';
    } else if (m.type === 'direct') {
      const on = c.online.has(m.peer_user_id);
      sub.textContent = on ? 'online' : (c.peer?.last_seen ? 'zuletzt online ' + new Date(c.peer.last_seen).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '');
    } else {
      const n = [...c.online].filter(id => id !== state.me.id).length;
      sub.textContent = `${c.members.size} Mitglieder` + (n ? `, ${n} online` : '');
    }
  }
  c.renderHead = renderHead;

  async function loadMembers() {
    const { data } = await sb.from('chat_members').select('user_id,last_read_at').eq('chat_id', chatId);
    c.members = new Map((data || []).map(r => [r.user_id, r.last_read_at]));
    await loadProfiles([...c.members.keys()]);
  }

  async function loadMessages(before) {
    let q = sb.from('messages').select('*').eq('chat_id', chatId).order('created_at', { ascending: false }).limit(PAGE);
    if (before) q = q.lt('created_at', before);
    const { data, error } = await q;
    if (error) { toast(error.message); return 0; }
    const rows = (data || []).reverse();
    if (rows.length < PAGE) c.oldestReached = true;
    for (const m of rows) if (!c.byId.has(m.id)) { c.byId.set(m.id, m); c.msgs.push(m); }
    c.msgs.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    await loadProfiles(rows.map(r => r.sender_id));
    const missing = rows.map(r => r.reply_to).filter(id => id && !c.byId.has(id));
    if (missing.length) {
      const r = await sb.from('messages').select('*').in('id', [...new Set(missing)]);
      (r.data || []).forEach(m => { if (!c.byId.has(m.id)) c.byId.set(m.id, m); });
    }
    return rows.length;
  }
  c.loadOlder = async () => {
    const first = c.msgs[0];
    if (!first) return;
    const h = c.msgsEl.scrollHeight;
    await loadMessages(first.created_at);
    render(false);
    c.msgsEl.scrollTop = c.msgsEl.scrollHeight - h;
  };

  async function addMessage(m, mine) {
    if (c.dead) return;
    if (c.byId.has(m.id)) { c.byId.set(m.id, Object.assign(c.byId.get(m.id), m)); const i = c.msgs.findIndex(x => x.id === m.id); if (i >= 0) c.msgs[i] = c.byId.get(m.id); }
    else { c.byId.set(m.id, m); c.msgs.push(m); }
    await loadProfiles([m.sender_id]);
    if (m.reply_to && !c.byId.has(m.reply_to)) {
      const r = await sb.from('messages').select('*').eq('id', m.reply_to).maybeSingle();
      if (r.data) c.byId.set(r.data.id, r.data);
    }
    if (c.dead) return;
    render(mine || nearBottom());
    if (!mine && !document.hidden) markRead();
    refreshSoon();
  }

  function nearBottom() { return msgsEl.scrollHeight - msgsEl.scrollTop - msgsEl.clientHeight < 140; }

  function subscribe() {
    const ch = sb.channel('chat:' + chatId, { config: { presence: { key: state.me.id }, broadcast: { self: false } } });
    c.channel = ch;
    ch.on('broadcast', { event: 'typing' }, ({ payload }) => {
      if (!payload || payload.user_id === state.me.id) return;
      c.typing.set(payload.user_id, Date.now());
      loadProfiles([payload.user_id]).then(renderHead);
    });
    ch.on('presence', { event: 'sync' }, () => {
      c.online = new Set(Object.keys(ch.presenceState()));
      renderHead();
    });
    ch.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `chat_id=eq.${chatId}` },
      p => { c.typing.delete(p.new.sender_id); addMessage(p.new, p.new.sender_id === state.me.id); });
    ch.on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages', filter: `chat_id=eq.${chatId}` },
      p => { if (c.byId.has(p.new.id)) addMessage(p.new, false).then(() => { }); });
    ch.on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'chat_members', filter: `chat_id=eq.${chatId}` },
      p => { c.members.set(p.new.user_id, p.new.last_read_at); render(false); });
    ch.on('postgres_changes', { event: '*', schema: 'public', table: 'chats', filter: `id=eq.${chatId}` },
      async p => {
        if (p.eventType === 'DELETE') { toast('Dieser Chat wurde gelöscht.'); location.hash = '#/'; return; }
        const { data } = await sb.from('chat_overview').select('*').eq('chat_id', chatId).maybeSingle();
        if (data && !c.dead) { c.meta = data; renderHead(); }
      });
    ch.subscribe(status => { if (status === 'SUBSCRIBED') ch.track({ user_id: state.me.id, at: Date.now() }); });
  }

  function markRead() {
    call('mark_read', { p_chat_id: chatId }).then(refreshSoon).catch(() => { });
  }

  function isRead(m) {
    const others = [...c.members.entries()].filter(([id]) => id !== state.me.id);
    return others.length > 0 && others.every(([, t]) => t && new Date(t) >= new Date(m.created_at));
  }

  function openMenu(m) {
    const mine = m.sender_id === state.me.id;
    const b = [];
    if (!m.deleted_at) {
      b.push(['↩ Antworten', () => c.setContext('reply', m)]);
      if (mine && m.body && Date.now() - new Date(m.created_at) < EDIT_MS) b.push(['✎ Bearbeiten', () => c.setContext('edit', m)]);
      if (m.body) b.push(['⧉ Text kopieren', () => navigator.clipboard?.writeText(m.body).then(() => toast('Kopiert'))]);
      b.push([mine ? '🗑 Löschen' : '🗑 Für alle löschen (falls berechtigt)', async () => {
        if (!(await confirmDialog('Nachricht wirklich löschen?', 'Löschen'))) return;
        try {
          await call('delete_message', { p_message_id: m.id });
          m.deleted_at = new Date().toISOString();
          render(false);
        } catch (e) { toast(e.message); }
      }, 'danger']);
      if (!mine) b.push(['⚑ Melden', async () => {
        try { (await import('./features/report.js')).openReport(m.id); } catch { toast('Melden nicht verfügbar.'); }
      }, 'danger']);
    }
    if (!b.length) return;
    const modal = openModal('Nachricht', el('div', { class: 'menu-list' },
      b.map(([label, fnc, cls]) => el('button', { class: cls || '', onclick: () => { modal.close(); fnc(); } }, label))));
  }

  function bubble(m) {
    const mine = m.sender_id === state.me.id;
    const node = el('div', { class: 'msg' + (mine ? ' me' : '') + (m.deleted_at ? ' deleted' : ''), 'data-id': m.id });
    if (!mine && c.meta.type === 'group') {
      const who = el('div', { class: 'who' });
      who.innerHTML = nameHtml(profCache.get(m.sender_id));
      node.append(who);
    }
    if (m.reply_to && !m.deleted_at) {
      const r = c.byId.get(m.reply_to);
      const q = el('div', { class: 'quote', onclick: () => jumpTo(m.reply_to) });
      const qn = el('div', { class: 'qn' });
      qn.innerHTML = r ? nameHtml(profCache.get(r.sender_id)) : '';
      q.append(qn, el('div', { class: 'qt' }, !r ? 'Nachricht nicht verfügbar' : r.deleted_at ? 'Gelöschte Nachricht' : (r.body || '📷 Bild')));
      node.append(q);
    }
    if (m.deleted_at) {
      node.append(el('div', { class: 'body' }, 'Diese Nachricht wurde gelöscht'));
    } else {
      if (m.media_path) {
        const img = el('img', { class: 'pic', alt: 'Bild', loading: 'lazy' });
        signedUrl(m.media_path).then(u => { img.src = u; img.onclick = () => openModal('Bild', el('img', { src: u, style: 'max-width:100%;border-radius:6px' }), { wide: true }); })
          .catch(() => { img.alt = 'Bild nicht ladbar'; });
        node.append(img);
      }
      if (m.body) node.append(el('div', { class: 'body' }, m.body));
      node.append(el('button', { class: 'menu-btn', 'aria-label': 'Menü', onclick: () => openMenu(m) }, '▾'));
    }
    const meta = el('div', { class: 'meta' });
    if (m.edited_at && !m.deleted_at) meta.append(el('span', {}, 'bearbeitet'));
    meta.append(el('span', {}, clock(m.created_at)));
    if (mine && !m.deleted_at) {
      const r = isRead(m);
      meta.append(el('span', { class: 'ticks' + (r ? ' read' : '') }, r ? '✓✓' : '✓'));
    }
    node.append(meta);
    return node;
  }

  function jumpTo(id) {
    const n = msgsEl.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (n) { n.scrollIntoView({ block: 'center', behavior: 'smooth' }); n.classList.add('flash'); setTimeout(() => n.classList.remove('flash'), 1300); }
  }

  function render(stick) {
    if (c.dead) return;
    const keep = msgsEl.scrollTop;
    const nodes = [];
    if (!c.oldestReached && c.msgs.length) nodes.push(el('button', { class: 'btn ghost load-more', onclick: () => c.loadOlder() }, 'Ältere Nachrichten laden'));
    let day = '';
    for (const m of c.msgs) {
      const d = new Date(m.created_at).toDateString();
      if (d !== day) { day = d; nodes.push(el('div', { class: 'day-sep' }, dayLabel(m.created_at))); }
      nodes.push(bubble(m));
    }
    if (!c.msgs.length) nodes.push(el('div', { class: 'empty' }, 'Noch keine Nachrichten. Schreib die erste!'));
    msgsEl.replaceChildren(...nodes);
    msgsEl.scrollTop = stick ? msgsEl.scrollHeight : keep;
  }
}
