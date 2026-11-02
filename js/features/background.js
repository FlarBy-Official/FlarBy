import { el, toast } from '../core.js';

// Chat-Hintergrund, nur auf diesem Gerät gespeichert (localStorage "fc_bg").
const KEY = 'fc_bg';
export const PRESETS = [
  ['Standard', ''],
  ['Rosa', '#fde4e4'],
  ['Blau', '#dbeafe'],
  ['Grün', '#dcfce7'],
  ['Gelb', '#fef9c3'],
  ['Dunkel', '#1f1f24'],
  ['Sonnenuntergang', 'linear-gradient(160deg,#ff9a76,#ff4e50)'],
  ['Ozean', 'linear-gradient(160deg,#36d1dc,#5b86e5)'],
  ['Wald', 'linear-gradient(160deg,#56ab2f,#a8e063)'],
];

function load() {
  try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; }
}

export function applyBackground() {
  const b = load();
  const root = document.documentElement.style;
  if (!b?.value) { root.removeProperty('--chat-bg'); return; }
  root.setProperty('--chat-bg', b.type === 'image' ? `url("${b.value}") center/cover` : b.value);
}

function save(b) {
  try {
    if (b) localStorage.setItem(KEY, JSON.stringify(b)); else localStorage.removeItem(KEY);
  } catch { toast('Das Bild ist zu groß für diesen Speicher.'); return false; }
  applyBackground();
  return true;
}

function resize(file, max = 1000) {
  return new Promise((ok, fail) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const s = Math.min(1, max / Math.max(img.width, img.height));
      const cv = document.createElement('canvas');
      cv.width = Math.round(img.width * s); cv.height = Math.round(img.height * s);
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      URL.revokeObjectURL(url);
      ok(cv.toDataURL('image/jpeg', 0.7));
    };
    img.onerror = () => { URL.revokeObjectURL(url); fail(new Error('Das Bild konnte nicht gelesen werden.')); };
    img.src = url;
  });
}

export function backgroundSettings() {
  const grid = el('div', { class: 'bg-grid' }, PRESETS.map(([name, value]) => el('button', {
    type: 'button', class: 'bg-swatch', title: name, 'aria-label': name,
    style: 'background:' + (value || 'var(--bg)'),
    onclick: () => { if (save(value ? { type: 'color', value } : null)) toast('Hintergrund: ' + name); },
  }, value ? '' : '∅')));
  const file = el('input', { type: 'file', accept: 'image/*', class: 'hidden' });
  file.addEventListener('change', async () => {
    const f = file.files?.[0];
    file.value = '';
    if (!f) return;
    try { if (save({ type: 'image', value: await resize(f) })) toast('Eigenes Bild gesetzt'); } catch (e) { toast(e.message); }
  });
  return el('div', {}, grid,
    el('div', { style: 'margin-top:8px' },
      el('button', { class: 'btn ghost small', onclick: () => file.click() }, '🖼 Eigenes Bild wählen'), ' ', file,
      el('button', { class: 'btn ghost small', onclick: () => { save(null); toast('Hintergrund zurückgesetzt'); } }, 'Zurücksetzen')),
    el('div', { class: 'muted small', style: 'margin-top:6px' }, 'Gilt nur auf diesem Gerät.'));
}

applyBackground();
