import { el, toast, openModal, call } from '../core.js';

const REASONS = ['Beleidigung / Mobbing', 'Spam', 'Unangemessener Inhalt', 'Bedrohung', 'Sonstiges'];

export function openReport(messageId) {
  const sel = el('select', {}, REASONS.map(r => el('option', { value: r }, r)));
  const txt = el('textarea', { rows: 3, maxlength: 500, placeholder: 'Weitere Details (optional)' });
  const m = openModal('Nachricht melden', el('div', {},
    el('p', {}, 'Warum möchtest du diese Nachricht melden? Das Team prüft die Meldung.'),
    el('label', { class: 'field' }, 'Grund', sel),
    txt,
    el('div', { class: 'row end' },
      el('button', { class: 'btn ghost', onclick: () => m.close() }, 'Abbrechen'),
      el('button', { class: 'btn', onclick: async e => {
        e.target.disabled = true;
        const reason = txt.value.trim() ? `${sel.value}: ${txt.value.trim()}` : sel.value;
        try { await call('report_message', { p_message_id: messageId, p_reason: reason }); toast('Danke, die Meldung wurde gesendet.'); m.close(); }
        catch (err) { toast(err.message); e.target.disabled = false; }
      } }, 'Melden'))));
}
