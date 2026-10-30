import { sb, el, toast, openModal, call } from '../core.js';

export const MIN_AGE = 14;

// Platzhalter: Der endgültige Text kommt vom Besitzer.
const PRIVACY_TEXT = [
  'Wir prüfen dein Alter. Dafür speichern wir dein Geburtsdatum und, wenn du es hochlädst, das Foto von deinem Ausweis.',
  'Nur das Team (Moderatoren, Admins, Owner) kann beides sehen. Jeder Blick auf ein Foto wird im Protokoll gespeichert.',
  'Die Daten bleiben gespeichert. Nur der Owner kann sie löschen.',
  'Bitte decke auf dem Ausweis alles ab außer Name, Geburtsdatum und Foto.',
];

const SETUP_MISSING = /age_my_state|schema cache|does not exist/i;

// Liefert den Alters-Stand. Ist die Datenbank noch nicht aktualisiert, zählt das als geprüft (wie bei der AGB).
export async function loadAgeState() {
  try {
    const r = await call('age_my_state');
    return r || { verified: true };
  } catch (e) {
    if (SETUP_MISSING.test(e.message)) return { verified: true, missing: true };
    throw e;
  }
}

// Zeigt das Alters-Formular / die Warteschlange, bis die Person geprüft ist. Gibt den Stand zurück.
export function ensureAge(root, st) {
  return new Promise(resolve => {
    let timer = null;
    const card = el('div', { class: 'auth-card' });
    root.replaceChildren(el('div', { class: 'auth-wrap' }, card));

    const stop = () => { clearInterval(timer); };
    const finish = s => { stop(); resolve(s); };
    const logout = el('p', {}, el('button', { type: 'button', class: 'link-btn', onclick: () => sb.auth.signOut() }, 'Abmelden'));

    async function refresh() {
      try {
        st = await loadAgeState();
        if (st.verified) return finish(st);
        render();
      } catch { /* beim nächsten Mal wieder */ }
    }

    function show(...nodes) {
      card.replaceChildren(el('h2', { style: 'margin:0 0 8px' }, 'Alter bestätigen'), ...nodes, logout);
    }

    function render() {
      stop();
      if (st.too_young) {
        timer = setInterval(refresh, 8000);
        return show(
          el('p', {}, `Du bist leider noch zu jung. FlarChat ist erst ab ${MIN_AGE} Jahren.`),
          el('p', { class: 'muted' }, 'Ein Admin kann dich freischalten. Diese Seite schaut selbst nach.'));
      }
      if (st.status === 'guardian_wait') {
        timer = setInterval(refresh, 8000);
        return show(el('p', {}, 'Dein Elternteil muss dich noch bestätigen. Bitte sag ihm Bescheid.'),
          el('p', { class: 'muted' }, 'Diese Seite schaut selbst nach.'));
      }
      if (['open', 'mod_ok', 'mod_no'].includes(st.status)) {
        timer = setInterval(refresh, 8000);
        return show(
          el('p', {}, st.status === 'open' ? 'Das Team prüft dich gerade.' : 'Ein Admin schaut noch einmal drüber.'),
          st.position ? el('p', { class: 'muted' }, `Du bist in der Warteschlange auf Platz ${st.position}.`) : '',
          el('p', { class: 'muted' }, 'Diese Seite schaut selbst nach. Du kannst sie offen lassen.'));
      }
      renderForm();
    }

    function renderForm() {
      const locked = !!st.birth_date;
      const birth = el('input', { type: 'date', required: true, value: st.birth_date || '', disabled: locked,
        max: new Date().toISOString().slice(0, 10), min: '1900-01-01' });
      const methodAusweis = el('input', { type: 'radio', name: 'age-method', value: 'ausweis', checked: true });
      const methodBuerge = el('input', { type: 'radio', name: 'age-method', value: 'buerge' });
      const photo = el('input', { type: 'file', accept: 'image/*' });
      const guardian = el('input', { type: 'text', placeholder: 'Benutzername deines Elternteils', maxlength: 20, autocapitalize: 'none' });
      const photoBox = el('label', { class: 'field' }, 'Foto von deinem Ausweis', photo);
      const guardianBox = el('label', { class: 'field', style: 'display:none' }, 'Elternteil', guardian);
      const consent = el('input', { type: 'checkbox', style: 'width:20px;height:20px;flex:none;accent-color:#FF2800' });
      const err = el('div', { class: 'error' });
      const btn = el('button', { class: 'btn block', type: 'submit' }, 'Absenden');
      const sync = () => {
        const a = methodAusweis.checked;
        photoBox.style.display = a ? '' : 'none';
        guardianBox.style.display = a ? 'none' : '';
      };
      methodAusweis.addEventListener('change', sync);
      methodBuerge.addEventListener('change', sync);

      const form = el('form', {},
        el('p', {}, `FlarChat ist erst ab ${MIN_AGE} Jahren. Bitte beweise dein Alter. Danach prüft das Team es.`),
        st.reject_reason ? el('p', { class: 'error' }, 'Abgelehnt: ' + st.reject_reason) : '',
        el('label', { class: 'field' }, 'Geburtsdatum', birth),
        locked ? el('p', { class: 'muted small' }, 'Dein Geburtsdatum ist schon gespeichert. Nur das Team kann es ändern.') : '',
        el('div', { class: 'field' },
          el('label', { style: 'display:flex;gap:8px;align-items:center;margin:6px 0;cursor:pointer' }, methodAusweis, 'Mit Ausweis-Foto'),
          el('label', { style: 'display:flex;gap:8px;align-items:center;margin:6px 0;cursor:pointer' }, methodBuerge, 'Ein Elternteil bürgt für mich')),
        photoBox, guardianBox,
        el('div', { class: 'muted small', style: 'margin:10px 0' }, PRIVACY_TEXT.map(t => el('p', { style: 'margin:4px 0' }, t))),
        el('label', { style: 'display:flex;align-items:flex-start;gap:8px;margin:10px 0;cursor:pointer' }, consent,
          el('span', {}, 'Ich habe den Datenschutz-Text gelesen und stimme zu.')),
        err, btn);

      form.addEventListener('submit', async e => {
        e.preventDefault();
        err.textContent = '';
        if (!consent.checked) { err.textContent = 'Bitte stimme dem Datenschutz-Text zu.'; return; }
        if (!locked && !birth.value) { err.textContent = 'Bitte gib dein Geburtsdatum ein.'; return; }
        const method = methodAusweis.checked ? 'ausweis' : 'buerge';
        btn.disabled = true;
        try {
          let dataUrl = null;
          if (method === 'ausweis') {
            if (!photo.files[0]) throw new Error('Bitte wähle ein Foto aus.');
            dataUrl = await shrinkPhoto(photo.files[0]);
          } else if (!guardian.value.trim()) throw new Error('Bitte gib den Benutzernamen deines Elternteils ein.');
          await call('age_submit', {
            p_birth: birth.value || null, p_method: method, p_guardian: guardian.value.trim(),
            p_photo: dataUrl, p_consent: true,
          });
          st = await loadAgeState();
          if (st.verified) return finish(st);
          render();
        } catch (x) { err.textContent = x.message; btn.disabled = false; }
      });
      show(form);
    }

    render();
    refresh();
  });
}

// Verkleinert das Foto auf höchstens 1600 Pixel und macht ein JPEG daraus (Ziel: unter ca. 1,5 MB)
async function shrinkPhoto(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((ok, fail) => {
      const i = new Image();
      i.onload = () => ok(i);
      i.onerror = () => fail(new Error('Dieses Foto kann ich nicht öffnen. Nimm ein JPG oder PNG.'));
      i.src = url;
    });
    let scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    for (let tries = 0; tries < 5; tries++) {
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.naturalWidth * scale));
      c.height = Math.max(1, Math.round(img.naturalHeight * scale));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      const out = c.toDataURL('image/jpeg', 0.82);
      if (out.length <= 1500000) return out;
      scale *= 0.75;
    }
    throw new Error('Das Foto ist zu groß.');
  } finally { URL.revokeObjectURL(url); }
}

// Für Eltern: Anfragen von Kindern bestätigen
export async function openGuardianRequests() {
  const box = el('div', {}, el('p', { class: 'muted' }, 'Lade …'));
  const m = openModal('Bürgen-Anfragen', box);
  async function load() {
    const rows = (await call('age_guardian_list')) || [];
    if (!rows.length) return box.replaceChildren(el('p', { class: 'muted' }, 'Keine offenen Anfragen.'));
    box.replaceChildren(el('p', { class: 'muted small' }, 'Bestätige nur, wenn die Person wirklich so alt ist, wie sie angibt.'),
      ...rows.map(r => {
        const answer = ok => async () => {
          try { await call('age_guardian_answer', { p_request: r.request_id, p_ok: ok }); toast('Gespeichert.'); load(); }
          catch (e) { toast(e.message); }
        };
        return el('div', { class: 'list-row col' },
          el('div', {}, el('strong', {}, r.display_name || r.username), ` @${r.username}`),
          el('div', { class: 'muted small' }, 'Geburtsdatum: ' + (r.birth_date ? new Date(r.birth_date).toLocaleDateString('de-DE') : '?')),
          el('div', { class: 'row' },
            el('button', { class: 'btn small', onclick: answer(true) }, 'Ich bürge'),
            el('button', { class: 'btn ghost small', onclick: answer(false) }, 'Nein')));
      }));
  }
  load().catch(e => box.replaceChildren(el('p', { class: 'error' }, e.message)));
  return m;
}
