import { sb, el, toast } from '../core.js';

const MAX_SEC = 120;
const AUDIO_EXT = /\.(webm|m4a|mp4|ogg)$/i;

export function isVoicePath(p) { return !!p && AUDIO_EXT.test(p); }

function pickType() {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const t of ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return '';
}

function fmt(s) { return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }

function extOf(mime) {
  if (mime.includes('mp4')) return { ext: 'm4a', type: 'audio/mp4' };
  if (mime.includes('ogg')) return { ext: 'ogg', type: 'audio/ogg' };
  return { ext: 'webm', type: 'audio/webm' };
}

export async function uploadVoice(chatId, blob) {
  const { ext, type } = extOf(blob.type || '');
  const path = `${chatId}/${crypto.randomUUID()}.${ext}`;
  const { error } = await sb.storage.from('media').upload(path, blob, { contentType: type });
  if (error) throw new Error(error.message || 'Upload fehlgeschlagen.');
  return path;
}

// Baut den Mikrofon-Knopf samt Aufnahme-Leiste. onSend(blob) sendet die Aufnahme.
export function createVoiceRecorder(onSend) {
  const bar = el('div', { class: 'voice-bar hidden' });
  let rec = null, stream = null, timer = null, chunks = [], url = null;

  const cleanup = () => {
    clearInterval(timer);
    if (stream) stream.getTracks().forEach(t => t.stop());
    if (url) URL.revokeObjectURL(url);
    rec = stream = timer = url = null;
    chunks = [];
    bar.classList.add('hidden');
    bar.replaceChildren();
  };

  function showPreview(blob) {
    url = URL.createObjectURL(blob);
    const send = el('button', { class: 'btn small' }, 'Senden');
    send.onclick = async () => {
      send.disabled = true;
      try { toast('Sprachnachricht wird gesendet …'); await onSend(blob); cleanup(); }
      catch (e) { send.disabled = false; toast(e.message); }
    };
    bar.replaceChildren(el('audio', { src: url, controls: '', preload: 'auto' }), send,
      el('button', { class: 'btn small secondary', onclick: cleanup }, 'Verwerfen'));
  }

  async function start() {
    if (rec) return;
    const mime = pickType();
    if (mime === null || !navigator.mediaDevices?.getUserMedia) {
      toast('Sprachnachrichten gehen auf diesem Gerät leider nicht.');
      return;
    }
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch { toast('Das Mikrofon ist nicht erlaubt. Bitte erlaube es in den Einstellungen.'); return; }
    try { rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream); }
    catch { cleanup(); toast('Aufnahme geht auf diesem Gerät leider nicht.'); return; }
    const recorder = rec;
    chunks = [];
    recorder.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.onstop = () => {
      clearInterval(timer);
      if (stream) stream.getTracks().forEach(t => t.stop());
      if (rec !== recorder) return;
      const blob = new Blob(chunks, { type: recorder.mimeType || mime || 'audio/webm' });
      if (!blob.size) { cleanup(); toast('Es wurde nichts aufgenommen.'); return; }
      showPreview(blob);
    };
    const t0 = Date.now();
    const clock = el('span', { class: 'voice-time' }, '🔴 0:00');
    const stop = el('button', { class: 'btn small', onclick: () => { if (recorder.state !== 'inactive') recorder.stop(); } }, 'Stopp');
    bar.replaceChildren(clock, el('span', { class: 'muted small' }, 'von 2:00'), stop,
      el('button', { class: 'btn small secondary', onclick: () => { recorder.onstop = null; if (recorder.state !== 'inactive') recorder.stop(); cleanup(); } }, 'Abbrechen'));
    bar.classList.remove('hidden');
    recorder.start();
    timer = setInterval(() => {
      const s = Math.floor((Date.now() - t0) / 1000);
      clock.textContent = '🔴 ' + fmt(s);
      if (s >= MAX_SEC && recorder.state !== 'inactive') recorder.stop();
    }, 250);
  }

  const btn = el('button', { class: 'icon-btn', 'aria-label': 'Sprachnachricht aufnehmen', onclick: start }, '🎤');
  return { btn, bar, cleanup };
}

// Audio-Player für den Chat; holt die Adresse selbst.
export function voicePlayer(path, getUrl) {
  const a = el('audio', { class: 'voice-audio', controls: '', preload: 'none' });
  getUrl(path).then(u => { a.src = u; }).catch(() => a.replaceWith(el('div', { class: 'muted small' }, 'Sprachnachricht nicht ladbar')));
  return a;
}
