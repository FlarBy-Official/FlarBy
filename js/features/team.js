import { sb, state, el, esc, toast, openModal, confirmDialog, call, nameHtml, fmtTime } from '../core.js';
import { avatarEl, avatarSignedUrl, parseAvatar } from '../avatar.js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../config.js';

const LEVEL = { user: 0, moderator: 1, admin: 2, owner: 3 };
const GLOBAL_LABEL = { user: 'Nutzer', moderator: 'Moderator', admin: 'Admin', owner: 'Owner' };

function ask(title, label, placeholder = '') {
  return new Promise(resolve => {
    const inp = el('input', { type: 'text', placeholder, maxlength: 300 });
    const m = openModal(title, el('div', {}, el('label', { class: 'field' }, label, inp),
      el('div', { class: 'row end' },
        el('button', { class: 'btn ghost', onclick: () => { m.close(); resolve(null); } }, 'Abbrechen'),
        el('button', { class: 'btn', onclick: () => { m.close(); resolve(inp.value.trim()); } }, 'OK'))));
  });
}

export function openTeamPanel() {
  const lvl = LEVEL[state.profile?.global_role] ?? 0;
  if (lvl < 1) return toast('Kein Zugriff.');
  const tabs = [['reports', 'Meldungen', 1, tabReports]];
  if (lvl >= 2) tabs.push(['tickets', 'Tickets', 2, tabTickets]);
  tabs.push(['users', 'Nutzer', 1, tabUsers]);

  const content = el('div', { class: 'team-content' });
  const bar = el('div', { class: 'tabs' });
  const m = openModal('Team-Bereich', el('div', {}, bar, content), { wide: true });
  function show(id) {
    bar.replaceChildren(...tabs.map(([k, l]) => el('button', { class: 'tab' + (k === id ? ' active' : ''), onclick: () => show(k) }, l)));
    const fn = tabs.find(t => t[0] === id)[3];
    content.replaceChildren(el('p', { class: 'muted' }, 'Lade …'));
    fn(content).catch(e => content.replaceChildren(el('p', { class: 'error' }, e.message)));
  }
  show('reports');
  return m;
}

async function profMap(ids) {
  ids = [...new Set(ids.filter(Boolean))];
  if (!ids.length) return {};
  const { data } = await sb.from('profiles_public').select('*').in('id', ids);
  return Object.fromEntries((data || []).map(p => [p.id, p]));
}

async function attachmentImg(path) {
  const { data, error } = await sb.storage.from('report-files').createSignedUrl(path, 600);
  if (error) return el('p', { class: 'error' }, 'Anhang nicht ladbar: ' + error.message);
  return el('img', { src: data.signedUrl, alt: 'Anhang', style: 'max-width:100%;max-height:260px;border-radius:8px' });
}

function avatarReportRow(a, reload) {
  const name = a.target_name || a.target_username || '?';
  const d = el('div', { class: 'list-row col' });
  const head = el('div', { class: 'row' }, avatarEl({ url: a.avatar, name, seed: a.target_user_id || a.target_chat_id, cls: 'lg' }));
  const txt = el('div', {});
  txt.innerHTML = `<div><strong>Avatar-Meldung: ${a.kind === 'chat' ? 'Gruppe ' : ''}${esc(name)}</strong> <span class="status status-${a.status === 'open' ? 'aktiv' : 'verwendet'}">${a.status === 'open' ? 'offen' : 'erledigt'}</span></div>
    <div>${esc(a.reason)}</div>
    <div class="muted small">von @${esc(a.reporter_username || '?')} · ${esc(fmtTime(a.created_at))}${a.kind === 'user' ? ` · Entfernungen: ${a.removals}${a.locked ? ' · gesperrt' : ''}` : ''}</div>`;
  head.append(txt);
  d.append(head);
  if (a.attachment_path) attachmentImg(a.attachment_path).then(i => d.insertBefore(i, d.children[1] || null));
  const act = (label, fn, cls = 'ghost') => el('button', { class: 'btn small ' + cls, onclick: async () => { try { await fn(); toast('Erledigt.'); reload(); } catch (e) { toast(e.message); } } }, label);
  const row = el('div', { class: 'row wrap' });
  if (a.avatar) row.append(act('Avatar entfernen', async () => {
    const t = await ask('Avatar entfernen', 'Grund (freiwillig)');
    if (t === null) throw new Error('Abgebrochen.');
    await call('team_remove_avatar', { p_kind: a.kind, p_target: a.kind === 'chat' ? a.target_chat_id : a.target_user_id, p_reason: (t || '').slice(0, 200) || null });
    await call('resolve_avatar_report', { p_id: a.id });
  }, 'danger'));
  if (a.status === 'open') row.append(act('Erledigt', () => call('resolve_avatar_report', { p_id: a.id }), ''));
  d.append(row);
  return d;
}

export async function tabReports(box) {
  const rows = (await call('list_reports')) || [];
  const avs = (await call('list_avatar_reports').catch(() => [])) || [];
  const pm = await profMap(rows.map(r => r.reporter_id));
  if (!rows.length && !avs.length) return box.replaceChildren(el('p', { class: 'muted' }, 'Keine Meldungen.'));
  const avRows = avs.map(a => avatarReportRow(a, () => tabReports(box)));
  box.replaceChildren(...avRows, ...rows.map(r => {
    const d = el('div', { class: 'list-row col' });
    d.innerHTML = `<div><strong>${esc(r.reason)}</strong> <span class="status status-${r.status === 'open' ? 'aktiv' : 'verwendet'}">${r.status === 'open' ? 'offen' : 'erledigt'}</span></div>
      <div class="muted small">von ${nameHtml(pm[r.reporter_id])} · ${esc(fmtTime(r.created_at))}</div>
      <div class="small" style="margin-top:4px">Nachricht von @${esc(r.message_sender_username || '?')}: ${r.message_deleted ? '<em class="muted">gelöscht</em> ' : ''}${esc(r.message_body || '[Bild]')}</div>`;
    d.append(el('div', { class: 'row' }, el('button', { class: 'btn small', onclick: () => reportDetail(r, () => tabReports(box)) }, 'Ansehen')));
    return d;
  }));
}

async function reportDetail(r, reload) {
  const ctx = (await call('report_context', { p_report_id: r.id }).catch(e => { toast(e.message); return null; })) || [];
  const pm = await profMap(ctx.map(x => x.sender_id));
  const list = el('div', { class: 'ctx-list' });
  call('report_attachment', { p_report_id: r.id }).then(async path => { if (path) list.before(await attachmentImg(path)); }).catch(() => { });
  for (const msg of ctx) {
    const d = el('div', { class: 'ctx-msg' + (msg.id === r.message_id ? ' flagged' : '') });
    d.innerHTML = `<div class="small">${nameHtml(pm[msg.sender_id])} <span class="muted">${esc(fmtTime(msg.created_at))}</span></div>
      <div>${msg.deleted_at ? '<em class="muted">gelöscht</em>' : esc(msg.body || (msg.media_path ? '[Bild]' : ''))}</div>`;
    list.append(d);
  }
  const target = ctx.find(x => x.id === r.message_id);
  const uid = target?.sender_id;
  const act = (label, fn, cls = 'ghost') => el('button', { class: 'btn small ' + cls, onclick: async () => { try { await fn(); toast('Erledigt.'); } catch (e) { toast(e.message); } } }, label);
  const actions = el('div', { class: 'row wrap' },
    act('Nachricht löschen', async () => { if (await confirmDialog('Gemeldete Nachricht löschen?', 'Löschen')) await call('mod_delete_message', { p_message_id: r.message_id }); }),
    uid && act('Verwarnen', async () => { const t = await ask('Verwarnen', 'Grund'); if (t) await call('warn_user', { p_user_id: uid, p_reason: t }); }),
    uid && act('Stummschalten', async () => { const h = await ask('Stummschalten', 'Stunden', '24'); if (h) await call('mute_user', { p_user_id: uid, p_hours: parseInt(h, 10) || 24 }); }),
    r.status === 'open' && act('Als erledigt markieren', async () => { await call('resolve_report', { p_report_id: r.id }); m.close(); reload(); }, ''));
  const m = openModal('Meldung', el('div', {}, el('p', {}, el('strong', {}, 'Grund: '), r.reason), list, actions), { wide: true });
}

export async function tabTickets(box) {
  const rows = (await call('list_tickets')) || [];
  if (!rows.length) return box.replaceChildren(el('p', { class: 'muted' }, 'Keine Tickets.'));
  box.replaceChildren(...rows.map(t => {
    const d = el('div', { class: 'list-row col' });
    d.innerHTML = `<div><strong>@${esc(t.username)}</strong> <span class="status status-${t.status === 'open' ? 'aktiv' : 'verwendet'}">${t.status === 'open' ? 'offen' : 'erledigt'}</span> <span class="muted small">${esc(fmtTime(t.created_at))}</span></div><div>${esc(t.message)}</div>`;
    if (t.status === 'open') d.append(el('div', { class: 'row wrap' },
      el('button', { class: 'btn small', onclick: () => resetPassword(t, () => tabTickets(box)) }, 'Passwort zurücksetzen'),
      el('button', { class: 'btn ghost small', onclick: async () => { try { await call('close_ticket', { p_ticket_id: t.id }); tabTickets(box); } catch (e) { toast(e.message); } } }, 'Schließen')));
    return d;
  }));
}

async function resetPassword(t, reload) {
  try {
    const { data: u } = await sb.from('profiles_public').select('id').eq('username', String(t.username).toLowerCase()).maybeSingle();
    if (!u) return toast('Benutzer nicht gefunden.');
    if (!await confirmDialog(`Passwort von @${t.username} zurücksetzen?`, 'Zurücksetzen')) return;
    const { data: { session } } = await sb.auth.getSession();
    const res = await fetch(`${SUPABASE_URL}/functions/v1/admin-reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}`, apikey: SUPABASE_ANON_KEY },
      body: JSON.stringify({ ticket_id: t.id, user_id: u.id }),
    });
    const j = await res.json().catch(() => ({}));
    if (!j.ok) throw new Error(j.error || 'Zurücksetzen fehlgeschlagen.');
    openModal('Temporäres Passwort', el('div', {},
      el('p', {}, 'Dieses Passwort wird nur einmal angezeigt. Gib es der Person weiter – sie muss es beim Login ändern.'),
      el('div', { class: 'code-big' }, j.temp_password)));
    reload();
  } catch (e) { toast(e.message); }
}

export async function tabUsers(box) {
  const me = state.profile, lvl = LEVEL[me.global_role];
  const rows = (await call('list_users')) || [];
  const avState = Object.fromEntries(((await call('avatar_state_list').catch(() => [])) || []).map(x => [x.user_id, x]));
  const ipOf = lvl >= 2 ? Object.fromEntries(((await call('latest_user_ips').catch(() => [])) || []).map(x => [x.user_id, x.ip])) : {};
  box.replaceChildren(...rows.map(u => {
    const d = el('div', { class: 'list-row wrap' });
    d.append(avatarEl({ url: u.avatar_url, name: u.display_name || u.username, seed: u.id, cls: 'sm' }));
    const av = avState[u.id];
    const lab = el('span', { class: 'grow' });
    lab.innerHTML = `${nameHtml({ ...u, team_role: u.global_role !== 'user' ? u.global_role : null })} <span class="muted small">@${esc(u.username)}</span>${ipOf[u.id] ? ` <span class="muted small">· IP ${esc(ipOf[u.id])}</span>` : ''}${u.banned ? ' <span class="status status-widerrufen">gesperrt</span>' : ''}${u.muted_until && new Date(u.muted_until) > new Date() ? ' <span class="status status-abgelaufen">stumm</span>' : ''}`;
    d.append(lab);
    if (u.id === me.id) return d;
    const b = (l, fn) => el('button', { class: 'btn ghost small', onclick: async () => { try { await fn(); toast('Gespeichert.'); tabUsers(box); } catch (e) { toast(e.message); } } }, l);
    const targetLvl = LEVEL[u.global_role] ?? 0;
    if (av?.removals) lab.innerHTML += ` <span class="muted small">Avatar entfernt: ${av.removals}×</span>${av.locked ? ' <span class="status status-widerrufen">Avatare gesperrt</span>' : ''}`;
    if (lvl >= 2) d.append(el('button', { class: 'btn ghost small', onclick: async () => {
      try {
        const ips = (await call('list_user_ips', { p_user_id: u.id })) || [];
        openModal('IP-Adressen von @' + u.username, ips.length
          ? el('div', {}, ips.map(i => el('div', { class: 'list-row' }, el('span', { class: 'grow' }, i.ip), el('span', { class: 'muted small' }, fmtTime(i.last_seen)),
            el('button', { class: 'btn ghost small', onclick: () => navigator.clipboard?.writeText(i.ip).then(() => toast('Kopiert'), () => toast('Kopieren geht nicht.')) }, 'Kopieren'))))
          : el('p', { class: 'muted' }, 'Noch keine IP gespeichert.'));
      } catch (e) { toast(e.message); }
    } }, 'IP'));
    if (u.avatar_url) d.append(b('Avatar entfernen', async () => {
      const t = await ask('Avatar entfernen', 'Grund (freiwillig)');
      if (t === null) throw new Error('Abgebrochen.');
      await call('team_remove_avatar', { p_kind: 'user', p_target: u.id, p_reason: (t || '').slice(0, 200) || null });
    }));
    d.append(b(av?.locked ? 'Avatare entsperren' : 'Avatare sperren', () => call('set_avatar_lock', { p_user_id: u.id, p_locked: !av?.locked })));
    d.append(b('Stumm', async () => { const h = await ask('Stummschalten', 'Stunden (0 = aufheben)', '24'); if (h !== null && h !== '') await call('mute_user', { p_user_id: u.id, p_hours: parseInt(h, 10) || 0 }); }));
    if (lvl >= 2 && targetLvl < lvl) d.append(b(u.banned ? 'Entsperren' : 'Sperren', async () => {
      if (await confirmDialog(`@${u.username} ${u.banned ? 'entsperren' : 'sperren'}?`, 'Ja')) await call('ban_user', { p_user_id: u.id, p_banned: !u.banned });
    }));
    if (lvl >= 3) {
      const sel = el('select', { 'aria-label': 'Globale Rolle' }, Object.entries(GLOBAL_LABEL).map(([k, l]) => el('option', { value: k, selected: k === u.global_role }, l)));
      sel.addEventListener('change', async () => { try { await call('set_global_role', { p_user_id: u.id, p_role: sel.value }); toast('Rolle geändert.'); tabUsers(box); } catch (e) { toast(e.message); } });
      d.append(sel, b(u.verified ? 'Badge entfernen' : 'Verifizieren', () => call('set_verified', { p_kind: 'user', p_id: u.id, p_value: !u.verified })));
    }
    return d;
  }));
}
