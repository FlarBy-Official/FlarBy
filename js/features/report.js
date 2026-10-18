import { sb, state, el, toast, openModal, call } from '../core.js';

const REASONS = ['Beleidigung / Mobbing', 'Spam', 'Unangemessener Inhalt', 'Bedrohung', 'Sonstiges'];

async function uploadAttachment(file) {
  if (!file) return null;
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error('Der Anhang muss ein Bild sein (JPG, PNG oder WebP).');
  if (file.size > 5 * 1024 * 1024) throw new Error('Der Anhang ist zu groß (maximal 5 MB).');
  const ext = file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg';
  const path = `${state.me.id}/${crypto.randomUUID()}.${ext}`;
  const { error } = await sb.storage.from('report-files').upload(path, file, { contentType: file.type });
  if (error) throw new Error(error.message || 'Anhang konnte nicht hochgeladen werden.');
  return path;
}

function openForm(title, intro, send) {
  const sel = el('select', {}, REASONS.map(r => el('option', { value: r }, r)));
  const txt = el('textarea', { rows: 3, maxlength: 500, placeholder: 'Weitere Details (optional)' });
  const file = el('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp' });
  const m = openModal(title, el('div', {},
    el('p', {}, intro),
    el('label', { class: 'field' }, 'Grund', sel),
    txt,
    el('label', { class: 'field' }, 'Bild anhängen (optional)', file),
    el('div', { class: 'row end' },
      el('button', { class: 'btn ghost', onclick: () => m.close() }, 'Abbrechen'),
      el('button', { class: 'btn', onclick: async e => {
        e.target.disabled = true;
        const reason = txt.value.trim() ? `${sel.value}: ${txt.value.trim()}` : sel.value;
        try {
          const att = await uploadAttachment(file.files[0]);
          await send(reason, att);
          toast('Danke, die Meldung wurde gesendet.');
          m.close();
        } catch (err) { toast(err.message); e.target.disabled = false; }
      } }, 'Melden'))));
}

export function openReport(messageId) {
  openForm('Nachricht melden', 'Warum möchtest du diese Nachricht melden? Das Team prüft die Meldung.',
    (reason, att) => call('report_message', { p_message_id: messageId, p_reason: reason, p_attachment: att }));
}

// kind: 'user' oder 'chat'
export function openAvatarReport(kind, targetId) {
  openForm('Avatar melden', 'Warum ist dieses Avatar nicht in Ordnung? Das Team prüft die Meldung.',
    (reason, att) => call('report_avatar', { p_kind: kind, p_target: targetId, p_reason: reason, p_attachment: att }));
}
