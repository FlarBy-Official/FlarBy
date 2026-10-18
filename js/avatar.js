import { sb, el, toast, openModal } from './core.js';

// Avatar-Werte in profiles.avatar_url / chats.avatar_url:
//   img:<pfad>            Foto im privaten Speicher "avatars"
//   emoji:<emoji>|#RRGGBB Emoji auf Farbe
//   http(s)://…           alte Bild-URL
//   leer                  Buchstabe auf Farbe aus dem Namen
export const AVATAR_COLORS = ['#FF2800', '#E67E22', '#D4A017', '#2E9E5B', '#1ABC9C', '#3498DB', '#8E44AD', '#E84393'];
export const AVATAR_EMOJIS = ['😀', '😎', '🤩', '🥳', '😺', '🐶', '🦊', '🐼', '🦁', '🐸', '🐵', '🦄', '🐙', '🦋', '🌈', '⭐', '🔥', '⚡', '🍕', '🍩', '⚽', '🎮', '🚀', '🎸'];

const urlCache = new Map();

function colorFor(seed) {
  let h = 0;
  for (const ch of String(seed || '?')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

function letter(name) { return (String(name || '?').trim()[0] || '?').toUpperCase(); }

export function parseAvatar(v) {
  if (!v) return null;
  if (v.startsWith('img:')) return { kind: 'photo', path: v.slice(4) };
  if (v.startsWith('emoji:')) {
    const [emoji, color] = v.slice(6).split('|');
    return { kind: 'emoji', emoji, color: color || AVATAR_COLORS[0] };
  }
  if (/^https?:\/\//.test(v)) return { kind: 'url', url: v };
  return null;
}

export async function avatarSignedUrl(path) {
  const hit = urlCache.get(path);
  if (hit && hit.exp > Date.now()) return hit.p;
  const p = sb.storage.from('avatars').createSignedUrl(path, 3600).then(({ data, error }) => {
    if (error) throw new Error(error.message);
    return data.signedUrl;
  });
  urlCache.set(path, { p, exp: Date.now() + 50 * 60 * 1000 });
  p.catch(() => urlCache.delete(path));
  return p;
}

// Füllt ein vorhandenes .avatar-Element
export function fillAvatar(node, { url, name, seed }) {
  const a = parseAvatar(url);
  node.replaceChildren();
  node.style.background = '';
  if (a?.kind === 'emoji') {
    node.style.background = a.color;
    node.textContent = a.emoji;
    return node;
  }
  if (a?.kind === 'photo' || a?.kind === 'url') {
    node.style.background = colorFor(seed || name);
    node.textContent = letter(name);
    const show = src => {
      const img = el('img', { src, alt: '', loading: 'lazy' });
      img.onload = () => node.replaceChildren(img);
    };
    if (a.kind === 'url') show(a.url);
    else avatarSignedUrl(a.path).then(show).catch(() => { });
    return node;
  }
  node.style.background = colorFor(seed || name);
  node.textContent = letter(name);
  return node;
}

export function avatarEl({ url, name, seed, cls = '' }) {
  return fillAvatar(el('div', { class: 'avatar ' + cls }), { url, name, seed });
}

// Foto: Mitte quadratisch ausschneiden und auf 256×256 verkleinern
function cropSquare(file, size = 256) {
  return new Promise((resolve, reject) => {
    if (!file || !file.type.startsWith('image/')) return reject(new Error('Bitte ein Bild auswählen.'));
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const s = Math.min(img.width, img.height);
      const c = document.createElement('canvas');
      c.width = c.height = size;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, size, size);
      ctx.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
      c.toBlob(b => b ? resolve(b) : reject(new Error('Bild konnte nicht verarbeitet werden.')), 'image/jpeg', 0.85);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Bild konnte nicht gelesen werden.')); };
    img.src = url;
  });
}

// prefix: "u/<user_id>" oder "c/<chat_id>"; liefert den Wert für die Datenbank
export async function uploadAvatarPhoto(file, prefix) {
  const blob = await cropSquare(file);
  const path = `${prefix}/${crypto.randomUUID()}.jpg`;
  const { error } = await sb.storage.from('avatars').upload(path, blob, { contentType: 'image/jpeg' });
  if (error) throw new Error(error.message || 'Hochladen fehlgeschlagen.');
  return 'img:' + path;
}

function emojiPicker(onPick) {
  let emoji = AVATAR_EMOJIS[0], color = AVATAR_COLORS[0];
  const prev = el('div', { class: 'avatar lg' });
  const draw = () => { prev.style.background = color; prev.textContent = emoji; };
  draw();
  const grid = el('div', { class: 'emoji-grid' });
  const cols = el('div', { class: 'color-row' });
  const redraw = () => {
    grid.replaceChildren(...AVATAR_EMOJIS.map(e => el('button', { type: 'button', class: e === emoji ? 'on' : '', onclick: () => { emoji = e; draw(); redraw(); } }, e)));
    cols.replaceChildren(...AVATAR_COLORS.map(c => el('button', { type: 'button', class: 'swatch' + (c === color ? ' on' : ''), style: `background:${c}`, 'aria-label': 'Farbe', onclick: () => { color = c; draw(); redraw(); } })));
  };
  redraw();
  const m = openModal('Emoji-Avatar', el('div', {}, el('div', { class: 'row' }, prev), grid, cols,
    el('div', { class: 'row end' },
      el('button', { class: 'btn ghost', onclick: () => m.close() }, 'Abbrechen'),
      el('button', { class: 'btn', onclick: async () => { m.close(); await onPick(`emoji:${emoji}|${color}`); } }, 'Übernehmen'))));
}

// Editor mit Vorschau. save(wert) speichert in der Datenbank (set_my_avatar / set_chat_avatar).
export function avatarEditor({ value, name, seed, prefix, save, locked = false, onChange }) {
  const box = el('div', { class: 'avatar-editor' });
  let current = value || null;
  const render = () => {
    const file = el('input', { type: 'file', accept: 'image/*', class: 'hidden' });
    file.addEventListener('change', async () => {
      const f = file.files[0];
      file.value = '';
      if (f) await apply(() => uploadAvatarPhoto(f, prefix));
    });
    const row = el('div', { class: 'row wrap' });
    if (!locked) {
      row.append(
        el('button', { class: 'btn small', onclick: () => file.click() }, '📷 Foto'),
        el('button', { class: 'btn small ghost', onclick: () => emojiPicker(v => apply(async () => v)) }, '😀 Emoji'));
      if (current) row.append(el('button', { class: 'btn small ghost', onclick: () => apply(async () => null) }, 'Entfernen'));
    }
    box.replaceChildren(
      el('div', { class: 'row' }, avatarEl({ url: current, name, seed, cls: 'lg' }),
        locked ? el('span', { class: 'muted small' }, 'Avatare sind für dich vom Team gesperrt.') : row),
      file);
  };
  async function apply(make) {
    try {
      const old = parseAvatar(current);
      const v = await make();
      await save(v);
      if (old?.kind === 'photo' && ('img:' + old.path) !== v) sb.storage.from('avatars').remove([old.path]).catch(() => { });
      current = v;
      onChange?.(v);
      render();
      toast('Gespeichert');
    } catch (e) { toast(e.message); }
  }
  render();
  return box;
}
