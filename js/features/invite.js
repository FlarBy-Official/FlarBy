import { el, esc, toast, openModal, call, fmtTime, nameHtml } from '../core.js';

export const fmtCode = c => {
  const d = String(c || '').replace(/\D/g, '');
  return d.replace(/(\d{4})(?=\d)/g, '$1-');
};

export function codeStatus(c) {
  if (c.revoked) return 'widerrufen';
  if (c.used_by || c.used_at) return 'verwendet';
  if (c.expires_at && new Date(c.expires_at) < new Date()) return 'abgelaufen';
  return 'aktiv';
}

const DURATIONS = [[1, '1 Stunde'], [24, '24 Stunden'], [72, '3 Tage'], [168, '7 Tage'], [720, '30 Tage']];

export async function qrDataUrl(text) {
  const QR = await import('https://esm.sh/qrcode@1');
  const lib = QR.default || QR;
  return lib.toDataURL(text, { margin: 1, width: 240 });
}

// Wiederverwendbar (auch team.js): zeigt Code groß + QR + Kopieren
export async function showCodeBox(container, code) {
  const shown = fmtCode(code);
  const img = el('img', { class: 'qr', alt: 'QR-Code', width: 240, height: 240 });
  container.replaceChildren(
    el('div', { class: 'code-big' }, shown),
    img,
    el('div', { class: 'row end' }, el('button', { class: 'btn ghost', onclick: async () => {
      try { await navigator.clipboard.writeText(shown); toast('Code kopiert.'); } catch { toast('Kopieren nicht möglich.'); }
    } }, 'Kopieren')));
  try { img.src = await qrDataUrl(shown.replace(/-/g, '')); } catch { img.remove(); }
}

export function openInvite(chatId) {
  const dur = el('select', {}, DURATIONS.map(([h, l]) => el('option', { value: h, selected: h === 24 }, l)));
  const out = el('div', { class: 'code-out' });
  const list = el('div', { class: 'code-list' });
  const q = el('input', { type: 'text', placeholder: 'Benutzername suchen …' });
  const found = el('div', {});
  const body = el('div', {},
    el('div', { class: 'row' }, el('label', { class: 'grow' }, 'Gültig für ', dur),
      el('button', { class: 'btn', onclick: async () => {
        try { const c = await call('create_chat_code', { p_chat_id: chatId, p_hours: +dur.value }); await showCodeBox(out, c); loadList(); }
        catch (e) { toast(e.message); }
      } }, 'Code erzeugen')),
    out,
    el('h4', {}, 'Direkt einladen'),
    el('p', { class: 'muted' }, 'Suche eine Person und teile ihr den Code oder QR-Code oben mit. Einladungen laufen immer über einen einmaligen Code.'),
    el('div', { class: 'row' }, q, el('button', { class: 'btn ghost', onclick: async () => {
      if (q.value.trim().length < 2) return;
      try {
        const r = await call('find_users', { p_query: q.value.trim() });
        found.replaceChildren(...(r || []).map(u => { const d = el('div', { class: 'list-row' }); d.innerHTML = `<span class="grow">${nameHtml(u)} <span class="muted">@${esc(u.username)}</span></span>`; return d; }));
        if (!(r || []).length) found.textContent = 'Niemand gefunden.';
      } catch (e) { toast(e.message); }
    } }, 'Suchen')),
    found,
    el('h4', {}, 'Codes'),
    list);
  openModal('Einladen', body, { wide: true });

  async function loadList() {
    try {
      const rows = await call('list_codes', { p_chat_id: chatId });
      renderCodeList(list, rows || [], loadList);
    } catch (e) { list.textContent = e.message; }
  }
  loadList();
}

// Gemeinsame Codeliste (Chat- und Registrier-Codes)
export function renderCodeList(list, rows, reload) {
  if (!rows.length) { list.replaceChildren(el('p', { class: 'muted' }, 'Keine Codes vorhanden.')); return; }
  list.replaceChildren(...rows.map(c => {
    const st = codeStatus(c);
    const acts = [];
    if (st === 'aktiv') acts.push(el('button', { class: 'btn ghost small', onclick: async () => {
      try { await call('revoke_code', { p_code_id: c.id }); reload(); } catch (e) { toast(e.message); }
    } }, 'Widerrufen'));
    else acts.push(el('button', { class: 'btn ghost small', onclick: async () => {
      try { const n = await call('reactivate_code', { p_code_id: c.id }); toast('Neuer Code: ' + fmtCode(n), 6000); reload(); } catch (e) { toast(e.message); }
    } }, 'Neuen Code aktivieren'));
    return el('div', { class: 'list-row' },
      el('span', { class: 'grow' }, el('code', {}, fmtCode(c.code)), ' ',
        el('span', { class: 'status status-' + st }, st),
        el('div', { class: 'muted small' }, 'läuft ab: ' + (c.expires_at ? fmtTime(c.expires_at) : '–'))),
      acts);
  }));
}

export function openJoin() {
  let stream = null, stopped = false;
  const input = el('input', { class: 'code-input', type: 'text', inputmode: 'numeric', maxlength: 14, placeholder: 'XXXX-XXXX-XXXX', autocomplete: 'off' });
  input.addEventListener('input', () => { input.value = fmtCode(input.value.replace(/\D/g, '').slice(0, 12)); });
  const video = el('video', { class: 'scan-video', playsinline: true, muted: true, hidden: true });
  const m = openModal('Chat beitreten', el('div', {},
    el('p', {}, 'Gib den Einladungscode ein oder scanne den QR-Code.'),
    input,
    el('div', { class: 'row end' },
      el('button', { class: 'btn ghost', onclick: scan }, 'QR scannen'),
      el('button', { class: 'btn', onclick: () => redeem(input.value) }, 'Beitreten')),
    video));
  const origClose = m.close;
  m.close = () => { stopCam(); origClose(); };
  const mo = new MutationObserver(() => { if (!document.body.contains(m.box)) { stopCam(); mo.disconnect(); } });
  mo.observe(document.body, { childList: true });

  function stopCam() { stopped = true; stream?.getTracks().forEach(t => t.stop()); stream = null; }

  async function redeem(raw) {
    const digits = String(raw).replace(/\D/g, '');
    if (digits.length !== 12) return toast('Der Code hat 12 Ziffern.');
    try {
      const chatId = await call('redeem_chat_code', { p_code: fmtCode(digits) });
      stopCam(); origClose();
      toast('Beigetreten!');
      window.dispatchEvent(new CustomEvent('flarchat:chat-joined', { detail: { chatId } }));
    } catch (e) { toast(e.message); }
  }

  async function scan() {
    if (!navigator.mediaDevices?.getUserMedia) return toast('Kamera nicht verfügbar.');
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    } catch { return toast('Kamerazugriff verweigert.'); }
    stopped = false;
    video.hidden = false; video.srcObject = stream; await video.play();
    let detect;
    if ('BarcodeDetector' in window) {
      const bd = new BarcodeDetector({ formats: ['qr_code'] });
      detect = async () => (await bd.detect(video))[0]?.rawValue;
    } else {
      const jsQR = (await import('https://esm.sh/jsqr@1')).default;
      const cv = document.createElement('canvas'), ctx = cv.getContext('2d', { willReadFrequently: true });
      detect = async () => {
        cv.width = video.videoWidth; cv.height = video.videoHeight;
        if (!cv.width) return null;
        ctx.drawImage(video, 0, 0);
        return jsQR(ctx.getImageData(0, 0, cv.width, cv.height).data, cv.width, cv.height)?.data;
      };
    }
    const tick = async () => {
      if (stopped) return;
      try {
        const v = await detect();
        if (v && v.replace(/\D/g, '').length === 12) { input.value = fmtCode(v); stopCam(); video.hidden = true; return redeem(v); }
      } catch { /* weiter versuchen */ }
      setTimeout(tick, 250);
    };
    tick();
  }
}
