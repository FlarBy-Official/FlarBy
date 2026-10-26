import { sb, state, el, esc, nameHtml, toast, call, openModal, closeModal, confirmDialog } from '../core.js';
import { avatarEditor } from '../avatar.js';
import { hasPin, setPin, removePin } from '../pinlock.js';

export function applyTheme(mode) {
  if (mode === 'dark' || mode === 'light') { localStorage.setItem('fc_theme', mode); document.documentElement.dataset.theme = mode; }
  else { localStorage.removeItem('fc_theme'); delete document.documentElement.dataset.theme; }
}
export function isDark() {
  const t = document.documentElement.dataset.theme;
  return t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
}

function section(title, ...nodes) {
  return el('div', { style: 'margin-bottom:18px' }, el('h3', { style: 'margin:0 0 6px;color:var(--red-dark)' }, title), ...nodes);
}
function toggle(label, checked, onchange) {
  const cb = el('input', { type: 'checkbox', style: 'width:20px;height:20px;accent-color:#FF2800' });
  cb.checked = checked;
  cb.addEventListener('change', () => onchange(cb.checked, cb));
  return el('label', { class: 'switch-row' }, el('span', {}, label), cb);
}

export function openSettings() {
  const p = state.profile || {};
  const root = el('div');
  const m = openModal('Einstellungen', root);

  // Profil
  const dn = el('input', { type: 'text', maxlength: '40', value: p.display_name || '' });
  const prev = el('div', { class: 'muted', style: 'margin-top:6px' });
  const showPrev = () => { prev.innerHTML = 'So sehen dich andere: ' + nameHtml(state.pub || { username: p.username, display_name: p.display_name }); };
  showPrev();
  root.append(section('Profil',
    el('div', { class: 'muted small' }, 'Benutzername: @' + (p.username || '')),
    el('label', { class: 'field' }, 'Anzeigename', dn),
    el('button', { class: 'btn', onclick: async () => {
      const v = dn.value.trim();
      if (!v) return toast('Der Anzeigename darf nicht leer sein.');
      if (!/^[\p{L}\p{N} _.-]+$/u.test(v)) return toast('Keine Sonderzeichen erlaubt. Nur Buchstaben, Zahlen, Leerzeichen und _ - .');
      const { error } = await sb.from('profiles').update({ display_name: v }).eq('id', state.me.id);
      if (error) return toast(error.message);
      p.display_name = v;
      if (state.pub) state.pub.display_name = v;
      showPrev();
      toast('Gespeichert');
    } }, 'Speichern'),
    prev,
    el('div', { class: 'muted small', style: 'margin-top:8px' }, 'Was die App speichert, steht in den ', el('a', { href: 'agb.html', target: '_blank', rel: 'noopener' }, 'AGB'), '.')));

  // Profilbild
  const avBox = el('div', {}, el('span', { class: 'muted small' }, 'Lade …'));
  root.append(section('Profilbild', avBox));
  call('my_avatar_state').then(r => {
    const st = Array.isArray(r) ? r[0] : r;
    avBox.replaceChildren(avatarEditor({
      value: state.pub?.avatar_url, name: p.display_name || p.username, seed: state.me.id, prefix: 'u/' + state.me.id,
      locked: !!st?.locked,
      save: v => call('set_my_avatar', { p_value: v }),
      onChange: v => { if (state.pub) state.pub.avatar_url = v; window.dispatchEvent(new CustomEvent('flarchat:avatar-changed')); },
    }));
  }).catch(e => avBox.replaceChildren(el('span', { class: 'error' }, e.message)));

  // Sichtbarkeit
  const vis = [];
  if (p.global_role && p.global_role !== 'user') {
    vis.push(toggle('Team-Tag neben meinem Namen anzeigen', p.team_tag_visible !== false, async (v, cb) => {
      try { await call('set_my_team_tag_visible', { p_value: v }); p.team_tag_visible = v; toast('Gespeichert'); }
      catch (e) { cb.checked = !v; toast(e.message); }
    }));
  }
  if (p.verified) {
    vis.push(toggle('Verifiziert-Siegel (✔) anzeigen', p.verified_visible !== false, async (v, cb) => {
      try { await call('set_my_verified_visible', { p_value: v }); p.verified_visible = v; toast('Gespeichert'); }
      catch (e) { cb.checked = !v; toast(e.message); }
    }));
  }
  if (vis.length) root.append(section('Sichtbarkeit', ...vis));

  // Darstellung
  root.append(section('Darstellung', toggle('Dunkelmodus', isDark(), v => applyTheme(v ? 'dark' : 'light'))));

  // App-PIN
  const pinBox = el('div');
  const renderPin = () => {
    pinBox.replaceChildren();
    if (hasPin()) {
      pinBox.append(el('p', { class: 'muted small' }, 'Eine App-PIN ist aktiv.'),
        el('button', { class: 'btn ghost', onclick: async () => { if (await confirmDialog('App-PIN entfernen?', 'Entfernen')) { removePin(); renderPin(); } } }, 'PIN entfernen'));
    } else {
      const inp = el('input', { type: 'password', inputmode: 'numeric', maxlength: '6', placeholder: '4–6 Ziffern', autocomplete: 'off' });
      pinBox.append(el('p', { class: 'muted small' }, 'Freiwillige Sperre dieser App auf diesem Gerät. Die PIN wird nur hier gespeichert.'), inp,
        el('div', { class: 'row end' }, el('button', { class: 'btn', onclick: async () => {
          try { await setPin(inp.value); toast('PIN gesetzt'); renderPin(); } catch (e) { toast(e.message); }
        } }, 'PIN festlegen')));
    }
  };
  renderPin();
  root.append(section('App-PIN', pinBox));

  // Passwort
  const np = el('input', { type: 'password', autocomplete: 'new-password', placeholder: 'Neues Passwort (mind. 8 Zeichen)' });
  root.append(section('Passwort ändern', np, el('div', { class: 'row end' }, el('button', { class: 'btn', onclick: async () => {
    if (np.value.length < 8) return toast('Das Passwort muss mindestens 8 Zeichen haben.');
    const { error } = await sb.auth.updateUser({ password: np.value });
    if (error) return toast(error.message);
    np.value = ''; toast('Passwort geändert');
  } }, 'Passwort ändern'))));


  root.append(el('button', { class: 'btn block', onclick: async () => { closeModal(); await sb.auth.signOut(); } }, 'Abmelden'));
}
