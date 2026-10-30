import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

// Mehrere Konten im selben Browser: Mit ?konto=2 (oder 3 …) im Link hat der Tab seinen eigenen Login.
// Ohne Angabe oder mit ?konto=1 gilt das normale Konto.
const KONTO = (() => {
  let k = new URLSearchParams(location.search).get('konto');
  try {
    if (k) sessionStorage.setItem('fc_konto', k); else k = sessionStorage.getItem('fc_konto');
  } catch { /* kein Speicher */ }
  return /^([2-9]|[1-9]\d)$/.test(k || '') ? k : '1';
})();
export const KONTO_NR = KONTO;
try {
  const seen = new Set((localStorage.getItem('fc_konten') || '').split(',').filter(Boolean));
  if (!seen.has(KONTO)) { seen.add(KONTO); localStorage.setItem('fc_konten', [...seen].join(',')); }
} catch { /* kein Speicher */ }

// Alle Konten dieses Browsers: [{ nr, name }] (name = Benutzername, wenn eingeloggt)
export function knownKonten() {
  const out = new Map([['1', null]]);
  try {
    for (const nr of (localStorage.getItem('fc_konten') || '').split(',')) if (nr) out.set(nr, null);
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i) || '';
      let nr = null;
      const m = key.match(/^sb-flarchat-konto-(\d+)$/);
      if (m) nr = m[1];
      else if (/^sb-[a-z0-9]+-auth-token$/.test(key) && !key.startsWith('sb-flarchat-konto-')) nr = '1';
      if (!nr) continue;
      let name = null;
      try { name = JSON.parse(localStorage.getItem(key))?.user?.email?.split('@')[0] || null; } catch { /* leer */ }
      out.set(nr, name);
    }
  } catch { /* kein Speicher */ }
  out.set(KONTO, out.get(KONTO) ?? null);
  return [...out].map(([nr, name]) => ({ nr, name })).sort((a, b) => a.nr - b.nr);
}

export const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, ...(KONTO === '1' ? {} : { storageKey: 'sb-flarchat-konto-' + KONTO }) },
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

// Formatierung: **fett**, //kursiv//, __unterstrichen__ (auch gemischt) und @Erwähnungen.
// Ohne zweites Zeichen endet die Formatierung bei der nächsten @Erwähnung, sonst bleibt der Text normal.
// mine = Set eigener Erwähnungen (klein geschrieben). Ohne mine und onMention werden Erwähnungen nicht hervorgehoben.
// onMention(token) wird beim Klick auf eine Erwähnung aufgerufen.
const FMT_RE = /\*\*|__|(?<!:)\/\/|@[\p{L}\p{N}_]+/gu;
const FMT_TAG = { '**': 'strong', '//': 'em', '__': 'u' };

export function plainText(text) {
  return richNodes(text || '').map(n => n.textContent).join('');
}

const REACT_RE = /\s*\/react\s*$/i;
export const hasReactMarker = body => REACT_RE.test(body || '');
const REACT_ANY = /(^|\s)\/react(?=\s|$)/gi;
export const stripReact = body => String(body || '').replace(REACT_ANY, '$1').replace(/\s+$/, '');
// Setzt /React immer ans Ende, auch wenn es vorne oder in der Mitte getippt wurde.
export const moveReactToEnd = body => {
  const t = String(body || '');
  if (!/(^|\s)\/react(?=\s|$)/i.test(t)) return t;
  const rest = stripReact(t).replace(/[ \t]{2,}/g, ' ').trim();
  return rest ? rest + ' /React' : '';
};

export function richNodes(text, { mine, onMention } = {}) {
  text = stripReact(text);
  const toks = [];
  let last = 0;
  for (const m of text.matchAll(FMT_RE)) {
    if (m.index > last) toks.push({ t: 'text', s: text.slice(last, m.index) });
    toks.push({ t: m[0][0] === '@' ? 'mention' : 'mark', s: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) toks.push({ t: 'text', s: text.slice(last) });

  const hasContent = (a, b) => toks.slice(a, b).some(k => k.t !== 'mark' && k.s.trim());
  const end = new Map(); // Start-Index -> { to, closed }
  const stack = [];
  toks.forEach((k, i) => {
    if (k.t !== 'mark') return;
    const j = stack.findLastIndex(o => toks[o].s === k.s);
    if (j >= 0 && hasContent(stack[j] + 1, i)) {
      end.set(stack[j], { to: i, closed: true });
      stack.length = j;
    } else stack.push(i);
  });
  toks.forEach((k, i) => {
    if (k.t !== 'mark' || end.has(i)) return;
    const m = toks.findIndex((x, n) => n > i && x.t === 'mention');
    if (m > 0 && hasContent(i + 1, m)) end.set(i, { to: m, closed: false });
  });

  const render = (from, to) => {
    const out = [];
    for (let i = from; i < to; i++) {
      const k = toks[i];
      const e = end.get(i);
      if (k.t === 'mark' && e && e.to <= to) {
        out.push(el(FMT_TAG[k.s], {}, render(i + 1, e.to)));
        i = e.closed ? e.to : e.to - 1;
      } else if (k.t === 'mention' && (mine || onMention)) {
        out.push(el('span', {
          class: 'mention' + (mine?.has(k.s.toLowerCase()) ? ' me' : '') + (onMention ? ' click' : ''),
          onclick: onMention ? e => { e.stopPropagation(); onMention(k.s); } : null,
        }, k.s));
      } else out.push(k.s);
    }
    return out;
  };
  return render(0, toks.length).map(n => typeof n === 'string' ? document.createTextNode(n) : n);
}

export const STATUS = {
  online: '🟢 Online',
  sleep: '🌙 Schlafe',
  dnd: '🚫 Bitte nicht stören',
  school: '🏫 In der Schule',
};
export function statusLabel(key) { return Object.hasOwn(STATUS, key) ? STATUS[key] : ''; }
