import { sb } from './core.js';

const MAX = 1600;
const cache = new Map();

export function compressImage(file, max = MAX, quality = 0.82) {
  return new Promise((resolve, reject) => {
    if (!file || !file.type.startsWith('image/')) return reject(new Error('Bitte ein Bild auswählen.'));
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k);
      c.height = Math.round(img.height * k);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      c.toBlob(b => b ? resolve(b) : reject(new Error('Bild konnte nicht verarbeitet werden.')), 'image/jpeg', quality);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Bild konnte nicht gelesen werden.')); };
    img.src = url;
  });
}

// Lädt ein Bild in den Bucket `media` hoch und liefert den Pfad <chat_id>/<uuid>.jpg
export async function uploadImage(chatId, file) {
  const blob = await compressImage(file);
  const path = `${chatId}/${crypto.randomUUID()}.jpg`;
  const { error } = await sb.storage.from('media').upload(path, blob, { contentType: 'image/jpeg' });
  if (error) throw new Error(error.message || 'Upload fehlgeschlagen.');
  return path;
}

export async function signedUrl(path) {
  const hit = cache.get(path);
  if (hit && hit.exp > Date.now()) return hit.url;
  const { data, error } = await sb.storage.from('media').createSignedUrl(path, 3600);
  if (error) throw new Error(error.message);
  cache.set(path, { url: data.signedUrl, exp: Date.now() + 50 * 60 * 1000 });
  return data.signedUrl;
}
