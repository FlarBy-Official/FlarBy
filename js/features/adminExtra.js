import { el, esc, toast, call, confirmDialog } from '../core.js';

const fmt = iso => (iso ? new Date(iso).toLocaleString('de-DE') : '–');
const STATUS = { active: 'aktiv', used: 'benutzt', expired: 'abgelaufen', revoked: 'widerrufen' };

function searchBox(onInput) {
  const i = el('input', { type: 'search', placeholder: 'Suchen …', style: 'width:100%;margin:6px 0' });
  i.addEventListener('input', () => onInput(i.value.trim().toLowerCase()));
  return i;
}

export async function statsView(view) {
  const s = (await call('admin_stats')) || {};
  const card = (icon, label, val) => el('div', { class: 'admin-msg', style: 'text-align:center' },
    el('div', { style: 'font-size:28px;font-weight:700' }, `${icon} ${val ?? 0}`), el('div', { class: 'muted small' }, label));
  view.replaceChildren(el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px' },
    card('👥', 'Nutzer', s.users), card('🆕', 'Neu (7 Tage)', s.users_new_7d), card('🟢', 'Gerade online', s.online_now),
    card('📅', 'Heute aktiv', s.active_today), card('🚫', 'Gesperrt', s.banned),
    card('💬', 'Chats', s.chats), card('👪', 'Gruppen', s.groups),
    card('✉️', 'Nachrichten', s.messages), card('📨', 'Nachrichten heute', s.messages_today), card('🖼', 'Bilder', s.images),
    card('🚩', 'Offene Meldungen', s.open_reports), card('🎫', 'Offene Tickets', s.open_tickets)));
}

export async function activityView(view) {
  const rows = (await call('admin_users_activity')) || [];
  const list = el('div', {});
  const draw = q => list.replaceChildren(...rows
    .filter(u => !q || `${u.username} ${u.display_name}`.toLowerCase().includes(q))
    .map(u => {
      const on = u.last_seen && Date.now() - new Date(u.last_seen) < 5 * 60 * 1000;
      const d = el('div', { class: 'list-row wrap' });
      d.innerHTML = `<span>${on ? '🟢' : '⚪'}</span><span class="grow">${esc(u.display_name)} <span class="muted small">@${esc(u.username)}</span>${u.banned ? ' <span class="status status-widerrufen">gesperrt</span>' : ''}</span>
        <span class="muted small">${on ? 'online' : 'zuletzt ' + esc(fmt(u.last_seen))} · ${u.message_count} Nachr.</span>`;
      return d;
    }));
  draw('');
  view.replaceChildren(searchBox(draw), list);
}

export async function codesView(view) {
  const rows = (await call('admin_list_codes')) || [];
  const reload = () => codesView(view).catch(e => toast(e.message));
  const run = async fn => { try { await fn(); reload(); } catch (e) { toast(e.message); } };
  const newBtn = el('button', { class: 'btn small', onclick: () => run(async () => {
    const code = await call('create_register_code', { p_hours: 24 });
    toast('Neuer Code: ' + code, 8000);
  }) }, '＋ Neuer Registrier-Code (24 Std.)');
  const list = rows.map(c => {
    const d = el('div', { class: 'list-row wrap' });
    d.innerHTML = `<span class="grow"><strong>${esc(c.code)}</strong> <span class="muted small">${c.kind === 'register' ? 'Registrierung' : 'Chat: ' + esc(c.chat_name || '?')}</span></span>
      <span class="status status-${c.status === 'active' ? 'aktiv' : c.status === 'used' ? 'verwendet' : 'widerrufen'}">${STATUS[c.status]}</span>
      <span class="muted small">${c.used_by_username ? 'von @' + esc(c.used_by_username) : 'bis ' + esc(fmt(c.expires_at))}</span>`;
    if (c.status === 'active') d.append(el('button', { class: 'btn ghost small', onclick: () => run(() => call('admin_revoke_code', { p_code_id: c.id })) }, 'Widerrufen'));
    d.append(el('button', { class: 'btn ghost small', onclick: () => run(async () => {
      if (await confirmDialog('Code löschen?', 'Löschen')) await call('admin_delete_code', { p_code_id: c.id });
    }) }, '🗑'));
    return d;
  });
  view.replaceChildren(el('div', { class: 'row' }, newBtn), ...(rows.length ? list : [el('p', { class: 'muted' }, 'Keine Codes.')]));
}

export async function announceView(view) {
  const ta = el('textarea', { maxlength: '300', rows: '3', placeholder: 'z. B. Heute Abend ist Wartung.', style: 'width:100%' });
  const send = text => async () => {
    try { await call('admin_set_announcement', { p_text: text() }); toast(text() ? 'Ansage ist online.' : 'Ansage entfernt.'); } catch (e) { toast(e.message); }
  };
  view.replaceChildren(
    el('p', {}, 'Alle sehen diese Ansage beim nächsten Öffnen der App.'), ta,
    el('div', { class: 'row' },
      el('button', { class: 'btn', onclick: send(() => ta.value) }, '📢 An alle senden'),
      el('button', { class: 'btn ghost', onclick: send(() => '') }, 'Ansage entfernen')));
}

export async function wordsView(view) {
  const words = (await call('admin_list_words')) || [];
  const reload = () => wordsView(view).catch(e => toast(e.message));
  const input = el('input', { type: 'text', maxlength: '40', placeholder: 'Verbotenes Wort', class: 'grow' });
  const add = async () => {
    if (!input.value.trim()) return;
    try { await call('admin_add_word', { p_word: input.value }); reload(); } catch (e) { toast(e.message); }
  };
  input.addEventListener('keydown', e => { if (e.key === 'Enter') add(); });
  view.replaceChildren(
    el('p', { class: 'muted small' }, 'Nachrichten mit diesen Wörtern werden nicht gesendet. Das gilt auch für Wörter mit mindestens 80 % Ähnlichkeit, für Zahlentricks (z. B. 4 statt a, 1 oder ! statt i, 5 oder ? statt s) und für die Buchstaben mit Leerzeichen dazwischen. Der Owner darf alles.'),
    el('div', { class: 'row' }, input, el('button', { class: 'btn small', onclick: add }, 'Hinzufügen')),
    ...(words.length ? words.map(w => el('div', { class: 'list-row' }, el('span', { class: 'grow' }, w),
      el('button', { class: 'btn ghost small', onclick: async () => { try { await call('admin_remove_word', { p_word: w }); reload(); } catch (e) { toast(e.message); } } }, 'Entfernen')))
      : [el('p', { class: 'muted' }, 'Noch keine Wörter.')]));
}
