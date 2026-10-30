import { sb, state, el, esc, nameHtml, toast, call, openModal, confirmDialog, richNodes, statusLabel, hasReactMarker, stripReact, moveReactToEnd } from './core.js';
import { openMention } from './features/mentions.js';
import { uploadImage, signedUrl } from './media.js';
import { createVoiceRecorder, uploadVoice, isVoicePath, voicePlayer } from './features/voice.js';
import { fillAvatar, avatarEl } from './avatar.js';
import { refreshSoon, initial, isMuted, toggleMute, myMentionTokens, isChatPinned, toggleChatPin, chatChoices, MAX_PINNED_CHATS } from './chatlist.js';

const EDIT_MS = 3 * 24 * 3600 * 1000;
const PAGE = 60;
const EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

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
function mediaLabel(m) { return isVoicePath(m.media_path) ? '🎤 Sprachnachricht' : '📷 Bild'; }
function clock(iso) { return new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }); }

export async function openChat(chatId) {
  teardown();
  document.body.classList.add('chat-open');
  const c = cur = {
    id: chatId, msgs: [], byId: new Map(), members: new Map(), meta: null, peer: null, dead: false,
    reacts: new Map(), polls: new Map(), votes: new Map(), pinnedId: null, canPin: false, typing: new Map(), online: new Set(), reply: null, editing: null, lastTyping: 0, oldestReached: false,
  };

  const muteBtn = el('button', { class: 'icon-btn', onclick: () => {
    const now = toggleMute(chatId);
    showMute();
    toast(now ? 'Chat ist stumm.' : 'Chat ist nicht mehr stumm.');
  } });
  const showMute = () => {
    const m = isMuted(chatId);
    muteBtn.textContent = m ? '🔕' : '🔔';
    muteBtn.setAttribute('aria-label', m ? 'Stumm aufheben' : 'Chat stumm schalten');
  };
  showMute();
  const pinChatBtn = el('button', { class: 'icon-btn', onclick: () => {
    const r = toggleChatPin(chatId);
    if (r === null) { toast(`Du kannst höchstens ${MAX_PINNED_CHATS} Chats anpinnen.`); return; }
    showPinChat();
    toast(r ? 'Chat ist oben angepinnt.' : 'Chat ist nicht mehr angepinnt.');
  } });
  const showPinChat = () => {
    const p = isChatPinned(chatId);
    pinChatBtn.textContent = p ? '📍' : '📌';
    pinChatBtn.setAttribute('aria-label', p ? 'Chat nicht mehr oben anpinnen' : 'Chat oben anpinnen');
  };
  showPinChat();
  const startChatCall = video => async () => {
    const group = c.meta?.type === 'group';
    const ids = [...c.members.keys()];
    if (!group && c.peer && !ids.includes(c.peer.id)) ids.push(c.peer.id);
    const title = group ? (c.meta.name || 'Gruppe') : (c.peer.display_name || c.peer.username);
    try { (await import('./features/call.js')).startCall({ chatId, memberIds: ids, title, video, isGroup: group }); } catch { toast('Anrufe sind gerade nicht verfügbar.'); }
  };
  const callBtn = el('div', { class: 'hidden', style: 'display:contents' },
    el('button', { class: 'icon-btn', 'aria-label': 'Sprachanruf', title: 'Sprachanruf', onclick: startChatCall(false) }, '📞'),
    el('button', { class: 'icon-btn', 'aria-label': 'Videoanruf', title: 'Videoanruf', onclick: startChatCall(true) }, '📹'));
  c.callBtn = callBtn;
  const closeTicketBtn = el('button', { class: 'btn small hidden', onclick: () => closeTicket() }, '🔒 Schließen');
  const title = el('div', { class: 't1' });
  const sub = el('div', { class: 't2' });
  const avatar = el('div', { class: 'avatar sm' }, '…');
  c.title = title; c.sub = sub; c.avatar = avatar;
  const head = el('div', { class: 'chat-head' },
    el('button', { class: 'icon-btn back-btn', 'aria-label': 'Zurück', onclick: () => { location.hash = '#/'; } }, '←'),
    avatar,
    el('div', { class: 'info', onclick: async () => {
      if (['ticket', 'channel'].includes(c.meta?.type)) return;
      try { (await import('./features/chatInfo.js')).openChatInfo(chatId); } catch { toast('Chat-Info nicht verfügbar.'); }
    } }, title, sub),
    closeTicketBtn, callBtn, pinChatBtn, muteBtn);
  const msgsEl = el('div', { class: 'msgs' });
  c.msgsEl = msgsEl;

  const ctxBar = el('div', { class: 'ctx-bar hidden' });
  c.ctxBar = ctxBar;
  const ta = el('textarea', { rows: '1', placeholder: 'Nachricht', maxlength: '4000' });
  c.ta = ta;
  const draftKey = 'fc_draft_' + chatId;
  try { ta.value = localStorage.getItem(draftKey) || ''; } catch { /* kein Speicher */ }
  const saveDraft = () => { try { if (ta.value && !c.editing) localStorage.setItem(draftKey, ta.value); else localStorage.removeItem(draftKey); } catch { /* kein Speicher */ } };
  const file = el('input', { type: 'file', accept: 'image/*', class: 'hidden' });
  const sendBtn = el('button', { class: 'icon-btn send', 'aria-label': 'Senden' }, '➤');
  const mentionBox = el('div', { class: 'mention-box hidden' });
  const voice = createVoiceRecorder(async blob => { await insertMessage({ body: '', media_path: await uploadVoice(chatId, blob) }); });
  const pollBtn = el('button', { class: 'icon-btn', 'aria-label': 'Umfrage erstellen', onclick: () => openPollForm() }, '📊');
  const composerRow = el('div', { class: 'composer' },
    el('button', { class: 'icon-btn', 'aria-label': 'Bild senden', onclick: () => file.click() }, '📎'),
    voice.btn, pollBtn, file, ta, sendBtn);
  const closedBar = el('div', { class: 'ticket-closed hidden' });
  const composer = el('div', { class: 'composer-wrap' }, mentionBox, ctxBar, voice.bar, composerRow, closedBar);
  const pinBar = el('div', { class: 'pin-bar hidden' });
  c.pinBar = pinBar;
  pane.replaceChildren(head, pinBar, msgsEl, composer);

  // TAB-Auswahl: cyc merkt sich Liste, aktuellen Eintrag und den ersetzten Bereich im Textfeld.
  let cyc = null;
  const hideBox = () => mentionBox.classList.add('hidden');

  function listItems() {
    const items = [];
    const whole = /^\/([a-z]*)$/i.exec(ta.value);
    if (whole && !c.editing) {
      const q = whole[1].toLowerCase();
      const cmd = (name, label, run, text = '/' + name) => items.push({ label, run, text, from: 0, to: ta.value.length });
      if ('ticket'.startsWith(q)) cmd('ticket', '🎫 /ticket · Support-Ticket öffnen', runTicketCommand);
      if ('clear'.startsWith(q) && c.meta?.type !== 'ticket') cmd('clear', '🧹 /clear · Alle Nachrichten für immer löschen', runClearCommand);
      if (c.meta?.type === 'channel' && 'react'.startsWith(q)) cmd('react', '😀 /React · Alle dürfen auf diese Nachricht reagieren', null, ' /React');
      if (items.length) return items;
    }
    const rm = c.meta?.type === 'channel' && !c.editing ? /(^|\s)\/([a-z]*)$/i.exec(ta.value) : null;
    if (rm && 'react'.startsWith(rm[2].toLowerCase())) {
      const from = rm.index + rm[1].length;
      return [{ label: '😀 /React · Alle dürfen auf diese Nachricht reagieren', text: '/React', from, to: ta.value.length }];
    }
    const pos = ta.selectionStart ?? ta.value.length;
    const m = /(^|\s)@([\p{L}\p{N}_]*)$/u.exec(ta.value.slice(0, pos));
    if (!m) return [];
    const q = m[2].toLowerCase();
    const cands = [];
    for (const id of c.members.keys()) {
      const p = profCache.get(id);
      if (p?.username && id !== state.me.id) cands.push({ tag: p.username, label: p.display_name && p.display_name !== p.username ? p.display_name : '', icon: '👤' });
    }
    if (c.canMentionRoles) cands.push({ tag: 'everyone', label: 'Alle im Chat', icon: '📣' });
    if (c.canMentionRoles) for (const r of c.roleList || []) cands.push({ tag: r.name.toLowerCase().replace(/\s+/g, ''), label: 'Rolle', icon: '🏷' });
    const hits = cands.filter(x => x.tag.toLowerCase().startsWith(q)).sort((a, b) => a.tag.localeCompare(b.tag, 'de')).slice(0, 8);
    const from = pos - q.length - 1;
    return hits.map(h => ({ label: `${h.icon} @${h.tag}` + (h.label ? ` · ${h.label}` : ''), text: '@' + h.tag + ' ', from, to: pos }));
  }

  function renderBox(items, active = -1) {
    if (!items.length) { hideBox(); return; }
    mentionBox.classList.remove('hidden');
    mentionBox.replaceChildren(...items.map((it, i) => el('button', { type: 'button', class: i === active ? 'active' : '', onmousedown: e => e.preventDefault(), onclick: () => {
      hideBox();
      if (it.run) { it.run(); return; }
      applyItem(it);
      saveDraft();
      ta.focus();
    } }, it.label)));
  }

  function applyItem(it) {
    ta.value = ta.value.slice(0, it.from) + it.text + ta.value.slice(it.to);
    const caret = it.text === ' /React' ? 0 : it.from + it.text.length;
    ta.setSelectionRange(caret, caret);
  }

  function updateMentions() {
    cyc = null;
    renderBox(listItems());
  }

  function tabSelect() {
    if (cyc && ta.value !== cyc.value) cyc = null;
    if (!cyc) {
      const items = listItems();
      if (!items.length || mentionBox.classList.contains('hidden')) return false;
      cyc = { items, idx: -1, from: items[0].from, to: items[0].to };
    }
    cyc.idx = (cyc.idx + 1) % cyc.items.length;
    const it = cyc.items[cyc.idx];
    const cur = { ...it, from: cyc.from, to: cyc.to };
    applyItem(cur);
    cyc.to = cyc.from + it.text.length;
    cyc.value = ta.value;
    ta.style.height = 'auto';
    saveDraft();
    renderBox(cyc.items, cyc.idx);
    return true;
  }
  ta.addEventListener('keyup', e => { if (!['Enter', 'Tab', 'Shift'].includes(e.key) && !(cyc && e.key === 'Control')) updateMentions(); });
  ta.addEventListener('click', updateMentions);
  ta.addEventListener('input', () => {
    saveDraft();
    updateMentions();
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
    if (Date.now() - c.lastTyping > 2500 && c.channel) {
      c.lastTyping = Date.now();
      c.channel.send({ type: 'broadcast', event: 'typing', payload: { user_id: state.me.id } });
    }
  });
  ta.addEventListener('keydown', e => {
    if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && tabSelect()) { e.preventDefault(); return; }
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

  // /ticket wird nie gesendet. Es öffnet nur ein Fenster beim Nutzer.
  async function runTicketCommand() {
    ta.value = ''; ta.style.height = 'auto';
    saveDraft();
    mentionBox.classList.add('hidden');
    try { (await import('./features/ticket.js')).openTicketDialog(); } catch { toast('Tickets sind gerade nicht verfügbar.'); }
  }

  // /clear wird nie gesendet. Es löscht alle Nachrichten des Chats für immer.
  async function runClearCommand() {
    ta.value = ''; ta.style.height = 'auto';
    saveDraft();
    mentionBox.classList.add('hidden');
    if (!(await confirmDialog('Wirklich ALLE Nachrichten in diesem Chat für immer löschen? Das kann man nicht rückgängig machen. Das gilt für alle im Chat.', 'Alles löschen'))) return;
    try {
      await call('clear_chat', { p_chat_id: chatId });
      c.msgs = []; c.byId.clear(); c.reacts.clear(); c.pinnedId = null;
      await loadPin();
      render(true);
      toast('Chat geleert.');
      refreshSoon();
    } catch (e) { toast(e.message); }
  }

  async function closeTicket() {
    if (!(await confirmDialog('Ticket wirklich schließen? Der Nutzer kann dann nichts mehr schreiben. Das Ticket verschwindet aus der Chatliste des Teams.', 'Schließen'))) return;
    try {
      await call('close_support_ticket', { p_chat_id: chatId });
      toast('Ticket geschlossen.');
      location.hash = '#/';
      refreshSoon();
    } catch (e) { toast(e.message); }
  }

  const isStaffWriter = () => ['admin', 'owner'].includes(state.profile?.global_role);

  // Ticket-Chat: keine Umfragen/Sprachnachrichten; geschlossen = nur lesen
  async function applyTicketState() {
    if (c.meta?.type === 'channel') {
      const staff = isStaffWriter();
      pollBtn.classList.toggle('hidden', !staff);
      composerRow.classList.toggle('hidden', !staff);
      closedBar.classList.toggle('hidden', staff);
      closedBar.replaceChildren(el('span', {}, '📢 Nur Admins und der Owner können hier schreiben.'));
      muteBtn.classList.add('hidden');
      pinChatBtn.classList.add('hidden');
      return;
    }
    const t = c.meta?.type === 'ticket';
    pollBtn.classList.toggle('hidden', t);
    voice.btn.classList.toggle('hidden', t);
    if (!t) return;
    const closed = c.meta.ticket_status === 'closed';
    composerRow.classList.toggle('hidden', closed);
    closedBar.classList.toggle('hidden', !closed);
    closeTicketBtn.classList.toggle('hidden', closed || !['moderator', 'admin', 'owner'].includes(state.profile?.global_role));
    if (c.ticketOwner === undefined) {
      try { c.ticketOwner = (await (await import('./features/ticket.js')).myTicket())?.chat_id === chatId; } catch { c.ticketOwner = false; }
    }
    closedBar.replaceChildren(el('span', {}, '🔒 Dieses Ticket ist geschlossen. Man kann nichts mehr schreiben.'),
      c.ticketOwner ? el('button', { class: 'btn small', onclick: async () => {
        if (!(await confirmDialog('Ticket löschen? Es verschwindet dann bei dir.', 'Löschen'))) return;
        try {
          await call('delete_my_support_ticket', { p_chat_id: chatId });
          toast('Ticket gelöscht.');
          location.hash = '#/';
          refreshSoon();
        } catch (e) { toast(e.message); }
      } }, '🗑 Ticket löschen') : null);
  }

  async function send() {
    const text = moveReactToEnd(ta.value.trim());
    if (!text) return;
    if (/^\/ticket$/i.test(text) && !c.editing) { runTicketCommand(); return; }
    if (/^\/clear$/i.test(text) && !c.editing) { runClearCommand(); return; }
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
      saveDraft();
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
      el('div', { class: 'txt' }, (kind === 'edit' ? '✎ Bearbeiten: ' : '↩ Antwort: '), m.body ? richNodes(m.body) : mediaLabel(m)),
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
  callBtn.classList.toggle('hidden', !['direct', 'group'].includes(c.meta?.type));
  renderHead();
  applyTicketState();

  await Promise.all([loadMembers(), loadMessages(), loadReactions(), loadPolls(), loadPin()]);
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
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
  ta.focus();

  function renderHead() {
    const m = c.meta;
    const name = c.peer ? (c.peer.display_name || c.peer.username) : (m.name || 'Chat');
    fillAvatar(c.avatar, { url: c.peer ? c.peer.avatar_url : m.avatar_url, name, seed: c.peer ? c.peer.id : m.chat_id });
    title.innerHTML = c.peer ? nameHtml(c.peer) : esc(m.name || 'Chat') + (m.verified ? ' <span class="verified" title="Verifiziert">✔</span>' : '');
    if (c.peer && statusLabel(c.peer.status)) {
      const st = statusLabel(c.peer.status);
      title.insertAdjacentHTML('beforeend', ` <span class="status-emoji" title="${esc(st)}">${esc(st.split(' ')[0])}</span>`);
    }
    const typers = [...c.typing.keys()];
    if (typers.length) {
      sub.textContent = m.type === 'direct' ? 'schreibt …'
        : typers.map(id => (profCache.get(id)?.display_name || profCache.get(id)?.username || 'Jemand')).join(', ') + ' schreibt …';
    } else if (m.type === 'ticket') {
      sub.textContent = m.ticket_status === 'closed' ? 'Support-Ticket · geschlossen' : 'Support-Ticket · offen';
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

  async function loadPolls() {
    const [p, v] = await Promise.all([
      sb.from('polls').select('*').eq('chat_id', chatId),
      sb.from('poll_votes').select('poll_id,user_id,option_idx').eq('chat_id', chatId)]);
    (p.data || []).forEach(x => c.polls.set(x.id, x));
    (v.data || []).forEach(x => setVote(x.poll_id, x.user_id, x.option_idx));
  }

  function setVote(pollId, userId, idx) {
    let m = c.votes.get(pollId);
    if (!m) c.votes.set(pollId, m = new Map());
    if (idx == null) m.delete(userId); else m.set(userId, idx);
  }

  async function vote(poll, idx) {
    const old = c.votes.get(poll.id)?.get(state.me.id);
    try {
      await call('vote_poll', { p_poll_id: poll.id, p_option: idx });
      setVote(poll.id, state.me.id, old === idx ? null : idx);
      render(false);
    } catch (e) { toast(e.message); }
  }

  function openPollForm() {
    const q = el('input', { type: 'text', maxlength: '200', placeholder: 'Frage' });
    const opts = el('div', { class: 'poll-opts' });
    const addOpt = () => { if (opts.children.length < 6) opts.append(el('input', { type: 'text', maxlength: '80', placeholder: 'Antwort ' + (opts.children.length + 1) })); };
    addOpt(); addOpt();
    const m = openModal('Umfrage erstellen', el('div', {}, el('label', { class: 'field' }, 'Frage', q), opts,
      el('div', { class: 'row end' },
        el('button', { class: 'btn ghost', onclick: addOpt }, '+ Antwort'),
        el('button', { class: 'btn', onclick: async () => {
          try {
            await call('create_poll', { p_chat_id: chatId, p_question: q.value, p_options: [...opts.querySelectorAll('input')].map(i => i.value) });
            m.close();
          } catch (e) { toast(e.message); }
        } }, 'Senden'))));
    q.focus();
  }

  async function loadPin() {
    const { data } = await sb.from('chats').select('pinned_message_id').eq('id', chatId).maybeSingle();
    c.pinnedId = data?.pinned_message_id || null;
    if (state.profile && ['admin', 'owner'].includes(state.profile.global_role)) c.canPin = true;
    else {
      const { data: mem } = await sb.from('chat_members').select('role_id').eq('chat_id', chatId).eq('user_id', state.me.id).maybeSingle();
      if (mem?.role_id) {
        const { data: role } = await sb.from('chat_roles').select('permissions').eq('id', mem.role_id).maybeSingle();
        c.canPin = !!role?.permissions?.pin_messages;
      }
    }
    c.canMentionRoles = !!(state.profile && ['admin', 'owner'].includes(state.profile.global_role));
    if (c.canMentionRoles) c.roleList = (await sb.from('chat_roles').select('name').eq('chat_id', chatId)).data || [];
    await showPin();
  }

  async function showPin() {
    if (c.dead) return;
    if (!c.pinnedId || c.meta?.type === 'direct') { c.pinBar.classList.add('hidden'); c.pinBar.replaceChildren(); return; }
    let m = c.byId.get(c.pinnedId);
    if (!m) { m = (await sb.from('messages').select('*').eq('id', c.pinnedId).maybeSingle()).data; }
    if (!m || m.deleted_at) { c.pinBar.classList.add('hidden'); return; }
    c.pinBar.classList.remove('hidden');
    c.pinBar.replaceChildren(
      el('div', { class: 'txt', onclick: () => jumpTo(m.id) }, '📌 ', m.body ? richNodes(m.body, { onMention: t => openMention(t, chatId) }) : mediaLabel(m)),
      c.canPin ? el('button', { class: 'icon-btn', 'aria-label': 'Pin lösen', onclick: () => pinMessage(null) }, '✕') : null);
  }

  async function pinMessage(id) {
    try {
      await call('pin_message', { p_chat_id: chatId, p_message_id: id });
      c.pinnedId = id;
      await showPin();
      toast(id ? 'Nachricht angepinnt.' : 'Pin gelöst.');
    } catch (e) { toast(e.message); }
  }

  async function loadReactions() {
    const { data } = await sb.from('message_reactions').select('message_id,user_id,emoji').eq('chat_id', chatId);
    for (const r of data || []) setReaction(r.message_id, r.user_id, r.emoji);
  }

  function setReaction(msgId, userId, emoji) {
    let m = c.reacts.get(msgId);
    if (!m) c.reacts.set(msgId, m = new Map());
    if (emoji) m.set(userId, emoji); else m.delete(userId);
  }

  async function react(m, emoji) {
    const old = c.reacts.get(m.id)?.get(state.me.id);
    try {
      await call('react_message', { p_message_id: m.id, p_emoji: emoji });
      setReaction(m.id, state.me.id, old === emoji ? null : emoji);
      render(false);
    } catch (e) { toast(e.message); }
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
    if (m.poll_id && !c.polls.has(m.poll_id)) {
      const pr = await sb.from('polls').select('*').eq('id', m.poll_id).maybeSingle();
      if (pr.data) c.polls.set(pr.data.id, pr.data);
    }
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
    ch.on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'messages' },
      p => { const id = p.old?.id; if (id && c.byId.has(id)) { c.byId.delete(id); c.msgs = c.msgs.filter(x => x.id !== id); render(false); } });
    ch.on('postgres_changes', { event: '*', schema: 'public', table: 'message_reactions', filter: `chat_id=eq.${chatId}` },
      p => {
        const r = p.eventType === 'DELETE' ? p.old : p.new;
        if (!r?.message_id) return;
        setReaction(r.message_id, r.user_id, p.eventType === 'DELETE' ? null : r.emoji);
        render(false);
      });
    ch.on('postgres_changes', { event: '*', schema: 'public', table: 'poll_votes', filter: `chat_id=eq.${chatId}` },
      p => {
        const r = p.eventType === 'DELETE' ? p.old : p.new;
        if (!r?.poll_id) return;
        setVote(r.poll_id, r.user_id, p.eventType === 'DELETE' ? null : r.option_idx);
        render(false);
      });
    ch.on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'chat_members', filter: `chat_id=eq.${chatId}` },
      p => { c.members.set(p.new.user_id, p.new.last_read_at); render(false); });
    ch.on('postgres_changes', { event: '*', schema: 'public', table: 'chats', filter: `id=eq.${chatId}` },
      async p => {
        if (p.eventType === 'DELETE') { toast('Dieser Chat wurde gelöscht.'); location.hash = '#/'; return; }
        const { data } = await sb.from('chat_overview').select('*').eq('chat_id', chatId).maybeSingle();
        if (data && !c.dead) { c.meta = data; renderHead(); applyTicketState(); }
        loadPin().catch(() => { });
      });
    ch.on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'chat_members' },
      p => { if (p.old?.chat_id === chatId && p.old?.user_id === state.me.id && c.meta?.type === 'ticket') { location.hash = '#/'; refreshSoon(); } });
    ch.subscribe(status => { if (status === 'SUBSCRIBED') ch.track({ user_id: state.me.id, at: Date.now() }); });
  }

  function markRead() {
    call('mark_read', { p_chat_id: chatId }).then(refreshSoon).catch(() => { });
  }

  function isRead(m) {
    const others = [...c.members.entries()].filter(([id]) => id !== state.me.id);
    return others.length > 0 && others.every(([, t]) => t && new Date(t) >= new Date(m.created_at));
  }

  async function canDeleteOthers() {
    if (c.meta?.type === 'direct') return false;
    if (c.meta?.type === 'channel') return isStaffWriter();
    try {
      const { data: mem } = await sb.from('chat_members').select('role_id').eq('chat_id', chatId).eq('user_id', state.me.id).maybeSingle();
      if (!mem?.role_id) return false;
      const { data: role } = await sb.from('chat_roles').select('system_key,permissions').eq('id', mem.role_id).maybeSingle();
      return role?.system_key === 'owner' || !!role?.permissions?.delete_others_messages;
    } catch { return false; }
  }

  async function openMenu(m) {
    const mine = m.sender_id === state.me.id;
    const isTicket = c.meta?.type === 'ticket';
    const isChannel = c.meta?.type === 'channel';
    const ticketClosed = isTicket && c.meta.ticket_status === 'closed';
    const canDel = !ticketClosed && (mine || (!m.deleted_at && await canDeleteOthers()));
    const b = [];
    if (!m.deleted_at) {
      if (!ticketClosed && (!isChannel || isStaffWriter())) b.push(['↩ Antworten', () => c.setContext('reply', m)]);
      if (!ticketClosed && mine && m.body && Date.now() - new Date(m.created_at) < EDIT_MS) b.push(['✎ Bearbeiten', () => c.setContext('edit', m)]);
      if (c.canPin && c.meta?.type !== 'direct') b.push([c.pinnedId === m.id ? '📌 Pin lösen' : '📌 Anpinnen', () => pinMessage(c.pinnedId === m.id ? null : m.id)]);
      if (m.body) b.push(['⧉ Text kopieren', () => navigator.clipboard?.writeText(stripReact(m.body)).then(() => toast('Kopiert'))]);
      if (!m.is_system && !m.poll_id && !isTicket && !isChannel) b.push(['➦ Weiterleiten', () => openForward(m)]);
      if (!ticketClosed) b.push(['⏰ Erinnern', () => openRemind(m)]);
      if (canDel) b.push([mine ? '🗑 Löschen' : '🗑 Für alle löschen', async () => {
        if (!(await confirmDialog('Nachricht wirklich löschen?', 'Löschen'))) return;
        try {
          await call('delete_message', { p_message_id: m.id });
          m.deleted_at = new Date().toISOString();
          render(false);
        } catch (e) { toast(e.message); }
      }, 'danger']);
      if (!mine && !isTicket) b.push(['⚑ Melden', async () => {
        try { (await import('./features/report.js')).openReport(m.id); } catch { toast('Melden nicht verfügbar.'); }
      }, 'danger']);
    }
    if (!b.length) return;
    const mineEmoji = c.reacts.get(m.id)?.get(state.me.id);
    const canReact = !isChannel || isStaffWriter() || hasReactMarker(m.body);
    const emojiRow = m.deleted_at || isTicket || !canReact ? null : el('div', { class: 'emoji-row' }, EMOJIS.map(e =>
      el('button', { class: e === mineEmoji ? 'on' : '', 'aria-label': 'Reagieren mit ' + e, onclick: () => { modal.close(); react(m, e); } }, e)));
    const modal = openModal('Nachricht', el('div', { class: 'menu-list' }, emojiRow,
      b.map(([label, fnc, cls]) => el('button', { class: cls || '', onclick: () => { modal.close(); fnc(); } }, label))));
  }

  function openForward(m) {
    const choices = chatChoices();
    if (!choices.length) { toast('Keine Chats vorhanden.'); return; }
    const q = el('input', { type: 'search', placeholder: 'Chat suchen' });
    const list = el('div', { class: 'menu-list fwd-list' });
    const modal = openModal('Weiterleiten an …', el('div', {}, q, list));
    const draw = () => {
      const t = q.value.trim().toLowerCase();
      const hits = choices.filter(x => !t || x.text.toLowerCase().includes(t));
      list.replaceChildren(...(hits.length ? hits.map(x => el('button', { onclick: async () => {
        list.querySelectorAll('button').forEach(b => { b.disabled = true; });
        try {
          await forwardMessage(m, x.id);
          modal.close();
          toast('Weitergeleitet an ' + x.text);
        } catch (e) { toast(e.message); modal.close(); }
      } }, (x.type === 'direct' ? '💬 ' : '👥 ') + x.text)) : [el('div', { class: 'empty' }, 'Keine Treffer.')]));
    };
    q.addEventListener('input', draw);
    draw();
  }

  async function forwardMessage(m, targetId) {
    if (m.is_system) throw new Error('Systemnachrichten kann man nicht weiterleiten.');
    let path = null;
    if (m.media_path) {
      const res = await fetch(await signedUrl(m.media_path));
      if (!res.ok) throw new Error('Anhang konnte nicht geladen werden.');
      const blob = await res.blob();
      const ext = (m.media_path.split('.').pop() || 'jpg').toLowerCase();
      path = `${targetId}/${crypto.randomUUID()}.${ext}`;
      const { error } = await sb.storage.from('media').upload(path, blob, { contentType: blob.type || undefined });
      if (error) throw new Error(error.message || 'Upload fehlgeschlagen.');
    }
    const { error } = await sb.from('messages').insert({ chat_id: targetId, sender_id: state.me.id, body: m.body || '', media_path: path, forwarded: true });
    if (error) throw new Error(error.message);
    refreshSoon();
  }

  function openRemind(m) {
    const now = new Date();
    const at = (d, h) => { const x = new Date(d); x.setHours(h, 0, 0, 0); return x; };
    const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1);
    const evening = now.getHours() >= 17
      ? ['In 3 Stunden', new Date(Date.now() + 3 * 3600000)]
      : ['Heute Abend', at(now, 18)];
    const opts = [['In 1 Stunde', new Date(Date.now() + 3600000)], evening, ['Morgen', at(tomorrow, 9)]];
    const set = async (d) => {
      try {
        await call('create_reminder', { p_message_id: m.id, p_remind_at: d.toISOString() });
        modal.close();
        toast('Erinnerung gesetzt');
      } catch (e) { toast(e.message); }
    };
    const pad = n => String(n).padStart(2, '0');
    const loc = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    const inp = el('input', { type: 'datetime-local', min: loc(now) });
    const modal = openModal('Erinnern', el('div', { class: 'remind-opts' },
      opts.map(([label, d]) => el('button', { class: 'btn', onclick: () => set(d) }, label)),
      el('label', {}, 'Eigene Zeit', inp),
      el('button', { class: 'btn ghost', onclick: () => {
        const d = new Date(inp.value);
        if (!inp.value || isNaN(d) || d <= new Date()) return toast('Bitte eine Zeit in der Zukunft wählen.');
        set(d);
      } }, 'Eigene Zeit setzen')));
  }

  function bubble(m) {
    if (m.is_system && c.meta?.type === 'ticket') {
      return el('div', { class: 'sys-line', 'data-id': m.id }, m.body);
    }
    if (c.meta?.type === 'channel' && !m.deleted_at) {
      const sp = profCache.get(m.sender_id);
      const who = el('div', { class: 'chan-who' });
      who.innerHTML = '📢 ' + nameHtml(sp);
      const node = el('div', { class: 'chan-msg clickable', 'data-id': m.id });
      node.append(who);
      if (m.reply_to && !c.byId.get(m.reply_to)?.deleted_at) {
        const r = c.byId.get(m.reply_to);
        node.append(el('div', { class: 'quote', onclick: () => jumpTo(m.reply_to) }, r ? (r.body ? richNodes(r.body) : mediaLabel(r)) : 'Nachricht nicht verfügbar'));
      }
      if (m.media_path && isVoicePath(m.media_path)) {
        node.append(voicePlayer(m.media_path, signedUrl));
      } else if (m.media_path) {
        const img = el('img', { class: 'pic', alt: 'Bild', loading: 'lazy' });
        signedUrl(m.media_path).then(u => { img.src = u; img.onclick = () => openModal('Bild', el('img', { src: u, style: 'max-width:100%;border-radius:6px' }), { wide: true }); })
          .catch(() => { img.alt = 'Bild nicht ladbar'; });
        node.append(img);
      }
      const poll = m.poll_id && c.polls.get(m.poll_id);
      if (poll) node.append(pollBlock(poll));
      else if (m.body) node.append(el('div', { class: 'chan-body' }, richNodes(m.body, { mine: myMentionTokens(chatId), onMention: t => openMention(t, chatId) })));
      const rs = c.reacts.get(m.id);
      if (rs?.size) {
        const counts = new Map();
        for (const e of rs.values()) counts.set(e, (counts.get(e) || 0) + 1);
        const mineEmoji = rs.get(state.me.id);
        node.append(el('div', { class: 'reacts' }, [...counts].map(([e, n]) =>
          el('button', { class: 'react-chip' + (e === mineEmoji ? ' on' : ''), onclick: () => react(m, e) }, e + (n > 1 ? ' ' + n : '')))));
      }
      node.append(el('div', { class: 'chan-time' }, (m.edited_at ? 'bearbeitet · ' : '') + clock(m.created_at)));
      node.addEventListener('click', e => {
        if (e.target.closest('button, a, img, .quote, input')) return;
        if (String(window.getSelection()).length) return;
        openMenu(m);
      });
      return node;
    }
    if (m.is_system) {
      return el('div', { class: 'sys-msg', 'data-id': m.id },
        el('div', { class: 'sys-label' }, 'SYSTEM'), el('div', { class: 'sys-body' }, m.body));
    }
    const mine = m.sender_id === state.me.id;
    const node = el('div', { class: 'msg' + (mine ? ' me' : '') + (m.deleted_at ? ' deleted' : ''), 'data-id': m.id });
    if (!mine && (c.meta.type === 'group' || c.meta.type === 'ticket')) {
      const sp = profCache.get(m.sender_id);
      const who = el('div', { class: 'who' });
      who.innerHTML = nameHtml(sp);
      node.append(el('div', { class: 'who-row' }, avatarEl({ url: sp?.avatar_url, name: sp?.display_name || sp?.username, seed: m.sender_id, cls: 'xs' }), who));
    }
    if (m.reply_to && !m.deleted_at && !c.byId.get(m.reply_to)?.deleted_at) {
      const r = c.byId.get(m.reply_to);
      const q = el('div', { class: 'quote', onclick: () => jumpTo(m.reply_to) });
      const qn = el('div', { class: 'qn' });
      qn.innerHTML = r ? nameHtml(profCache.get(r.sender_id)) : '';
      q.append(qn, el('div', { class: 'qt' }, !r ? 'Nachricht nicht verfügbar' : r.body ? richNodes(r.body, { onMention: t => openMention(t, chatId) }) : mediaLabel(r)));
      node.append(q);
    }
    if (m.forwarded && !m.deleted_at) node.append(el('div', { class: 'fwd-label' }, '↪ Weitergeleitet'));
    if (!m.deleted_at) {
      if (m.media_path && isVoicePath(m.media_path)) {
        node.append(voicePlayer(m.media_path, signedUrl));
      } else if (m.media_path) {
        const img = el('img', { class: 'pic', alt: 'Bild', loading: 'lazy' });
        signedUrl(m.media_path).then(u => { img.src = u; img.onclick = () => openModal('Bild', el('img', { src: u, style: 'max-width:100%;border-radius:6px' }), { wide: true }); })
          .catch(() => { img.alt = 'Bild nicht ladbar'; });
        node.append(img);
      }
      const poll = m.poll_id && c.polls.get(m.poll_id);
      if (poll) node.append(pollBlock(poll));
      else if (m.body) node.append(el('div', { class: 'body' }, richNodes(m.body, { mine: myMentionTokens(chatId), onMention: t => openMention(t, chatId) })));
    }
    const rs = c.reacts.get(m.id);
    if (rs?.size && !m.deleted_at) {
      const counts = new Map();
      for (const e of rs.values()) counts.set(e, (counts.get(e) || 0) + 1);
      const mineEmoji = rs.get(state.me.id);
      node.append(el('div', { class: 'reacts' }, [...counts].map(([e, n]) =>
        el('button', { class: 'react-chip' + (e === mineEmoji ? ' on' : ''), onclick: () => react(m, e) }, e + (n > 1 ? ' ' + n : '')))));
    }
    if (!m.deleted_at) {
      node.classList.add('clickable');
      node.addEventListener('click', e => {
        if (e.target.closest('button, a, img, .quote, input')) return;
        if (String(window.getSelection()).length) return;
        openMenu(m);
      });
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

  function pollBlock(poll) {
    const votes = c.votes.get(poll.id) || new Map();
    const total = votes.size;
    const mineIdx = votes.get(state.me.id);
    return el('div', { class: 'poll' },
      el('div', { class: 'poll-q' }, '📊 ' + poll.question),
      poll.options.map((o, i) => {
        const n = [...votes.values()].filter(v => v === i).length;
        const pct = total ? Math.round(n * 100 / total) : 0;
        return el('button', { class: 'poll-opt' + (mineIdx === i ? ' on' : ''), onclick: () => vote(poll, i) },
          el('span', { class: 'poll-bar', style: `width:${pct}%` }),
          el('span', { class: 'poll-label' }, o),
          el('span', { class: 'poll-n' }, `${n} (${pct}%)`));
      }),
      el('div', { class: 'muted small' }, total === 1 ? '1 Stimme' : `${total} Stimmen`));
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
      if (m.deleted_at) continue;
      const d = new Date(m.created_at).toDateString();
      if (d !== day) { day = d; nodes.push(el('div', { class: 'day-sep' }, dayLabel(m.created_at))); }
      nodes.push(bubble(m));
    }
    if (!c.msgs.some(m => !m.deleted_at)) nodes.push(el('div', { class: 'empty' }, 'Noch keine Nachrichten. Schreib die erste!'));
    msgsEl.replaceChildren(...nodes);
    msgsEl.scrollTop = stick ? msgsEl.scrollHeight : keep;
  }
}
