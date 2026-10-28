import { el, toast, call, openModal } from '../core.js';
import { refreshChatList } from '../chatlist.js';

export const TICKET_REASONS = ['Frage', 'Problem / Fehler', 'Jemand melden / Beschwerde', 'Konto-Hilfe', 'Sonstiges'];
const MIN = 10;
const MAX = 500;

export async function myTicket() {
  const r = await call('my_support_ticket');
  return (Array.isArray(r) ? r[0] : r) || null;
}

const numLabel = n => '#' + String(n).padStart(4, '0');

// Wird bei /ticket aufgerufen. Nur der Nutzer selbst sieht dieses Fenster.
export async function openTicketDialog() {
  let t;
  try { t = await myTicket(); } catch (e) { toast(e.message); return; }
  if (t) return alreadyHasTicket(t);

  const sel = el('select', {}, TICKET_REASONS.map(r => el('option', { value: r }, r)));
  const txt = el('textarea', { rows: '5', maxlength: String(MAX), placeholder: 'Schreibe hier, was dein Anliegen ist …' });
  const count = el('div', { class: 'muted small' }, `0 / ${MAX} (mindestens ${MIN})`);
  const err = el('div', { class: 'error' });
  const send = el('button', { class: 'btn' }, '🎫 Ticket öffnen');
  txt.addEventListener('input', () => { count.textContent = `${txt.value.trim().length} / ${MAX} (mindestens ${MIN})`; });
  const m = openModal('Ticket öffnen', el('div', {},
    el('p', {}, 'Das Team schreibt dir in einem eigenen Chat zurück. Nur du und das Team können ihn sehen.'),
    el('label', { class: 'field' }, 'Grund', sel),
    el('label', { class: 'field' }, 'Dein Anliegen', txt), count, err,
    el('div', { class: 'row end' }, el('button', { class: 'btn ghost', onclick: () => m.close() }, 'Abbrechen'), send)));
  send.addEventListener('click', async () => {
    err.textContent = '';
    if (txt.value.trim().length < MIN) { err.textContent = `Bitte schreibe mindestens ${MIN} Zeichen.`; return; }
    send.disabled = true;
    try {
      const id = await call('open_support_ticket', { p_category: sel.value, p_text: txt.value });
      m.close();
      await refreshChatList();
      location.hash = '#/chat/' + id;
      toast('Dein Ticket ist offen.');
    } catch (e) { err.textContent = e.message; send.disabled = false; }
  });
  txt.focus();
}

function alreadyHasTicket(t) {
  const closed = t.status === 'closed';
  const m = openModal('Du hast schon ein Ticket', el('div', {},
    el('p', {}, closed
      ? `Dein Ticket ${numLabel(t.number)} ist geschlossen. Lösche es zuerst in seinem Chat, dann kannst du ein neues öffnen.`
      : `Dein Ticket ${numLabel(t.number)} ist noch offen. Schreibe dein Anliegen dort hinein.`),
    el('div', { class: 'row end' },
      el('button', { class: 'btn ghost', onclick: () => m.close() }, 'Schließen'),
      el('button', { class: 'btn', onclick: () => { m.close(); location.hash = '#/chat/' + t.chat_id; } }, 'Zu meinem Ticket'))));
}
