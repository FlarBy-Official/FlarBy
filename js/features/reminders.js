import { el, esc, call, state } from '../core.js';

let started = false;
let broken = false;
let busy = false;
const shown = new Set();

function ensureBox() {
  let box = document.getElementById('reminder-banners');
  if (!box) { box = el('div', { id: 'reminder-banners' }); document.body.append(box); }
  return box;
}

function showBanner(r) {
  if (shown.has(r.id)) return;
  shown.add(r.id);
  const text = r.body ? r.body.slice(0, 200) : (r.has_media ? '📷 Bild' : 'Nachricht gelöscht');
  const info = el('div', { class: 'reminder-text' });
  info.innerHTML = '⏰ <strong>Erinnerung:</strong> ' + esc(text) + (r.sender_username ? ' <small>von ' + esc(r.sender_username) + '</small>' : '');
  const done = () => { banner.remove(); call('mark_reminder_delivered', { p_id: r.id }).catch(() => { }); };
  const banner = el('div', { class: 'reminder-banner' }, info,
    el('div', { class: 'row end' },
      el('button', { class: 'btn', onclick: () => { done(); location.hash = '#/chat/' + r.chat_id; } }, 'Zur Nachricht'),
      el('button', { class: 'btn ghost', onclick: done }, 'OK')));
  ensureBox().append(banner);
  // Zugestellt zählt schon beim Anzeigen, damit es nicht doppelt kommt
  call('mark_reminder_delivered', { p_id: r.id }).catch(() => { });
}

async function check() {
  if (broken || busy || !state.me) return;
  busy = true;
  try {
    const rows = await call('list_due_reminders');
    (rows || []).forEach(showBanner);
  } catch { broken = true; }
  busy = false;
}

export function startReminders() {
  if (started) { check(); return; }
  started = true;
  check();
  setInterval(check, 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
}
