import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

export const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
});

// state.me = auth user, state.profile = Zeile aus my_profile()
export const state = { me: null, profile: null };

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// el('div', {class:'x', onclick: fn}, 'text' | Node | [..])
export function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (k === 'class') n.className = v;
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return n;
}

export function toast(msg, ms = 3000) {
  let box = document.getElementById('toasts');
  if (!box) { box = el('div', { id: 'toasts' }); document.body.append(box); }
  const t = el('div', { class: 'toast' }, msg);
  box.append(t);
  setTimeout(() => t.remove(), ms);
}

// Modal: openModal('Titel', node) -> { close }
export function openModal(title, content, { wide = false } = {}) {
  const overlay = el('div', { class: 'modal-overlay' });
  const box = el('div', { class: 'modal' + (wide ? ' wide' : '') },
    el('div', { class: 'modal-head' },
      el('strong', {}, title),
      el('button', { class: 'icon-btn', 'aria-label': 'Schließen', onclick: () => close() }, '✕')),
    el('div', { class: 'modal-body' }, content));
  overlay.append(box);
  overlay.addEventListener('mousedown', e => { if (e.target === overlay) close(); });
  document.body.append(overlay);
  function close() { overlay.remove(); }
  return { close, box };
}
export function closeModal() { document.querySelectorAll('.modal-overlay').forEach(o => o.remove()); }

export function confirmDialog(text, okLabel = 'OK') {
  return new Promise(resolve => {
    const m = openModal('Bestätigen', el('div', {},
      el('p', {}, text),
      el('div', { class: 'row end' },
        el('button', { class: 'btn ghost', onclick: () => { m.close(); resolve(false); } }, 'Abbrechen'),
        el('button', { class: 'btn', onclick: () => { m.close(); resolve(true); } }, okLabel))));
  });
}

// RPC mit deutscher Fehlermeldung (wirft Error)
export async function call(fn, args = {}) {
  const { data, error } = await sb.rpc(fn, args);
  if (error) throw new Error(error.message || 'Unbekannter Fehler');
  return data;
}

const TEAM = { owner: ['Owner', 'team-owner'], admin: ['Admin', 'team-admin'], moderator: ['Mod', 'team-mod'] };
// HTML für einen Namen aus profiles_public: [Team]-Tag (rot/blau/grün) + Name + winziges Verifiziert-Siegel
export function nameHtml(p) {
  if (!p) return '';
  const t = p.team_role && TEAM[p.team_role]
    ? `<span class="team-tag ${TEAM[p.team_role][1]}">[${TEAM[p.team_role][0]}]</span> ` : '';
  const v = p.verified ? ' <span class="verified" title="Verifiziert">✔</span>' : '';
  return `${t}${esc(p.display_name || p.username)}${v}`;
}

export function fmtTime(iso) {
  const d = new Date(iso), now = new Date();
  const same = d.toDateString() === now.toDateString();
  return same ? d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' });
}
