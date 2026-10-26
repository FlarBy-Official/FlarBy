import { call } from '../core.js';
import { VAPID_PUBLIC_KEY } from '../config.js';

const NOT_SET = 'REPLACE_WITH_VAPID_PUBLIC_KEY';
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;

export function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

function keyToBytes(b64) {
  const pad = '='.repeat((4 - b64.length % 4) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}
const toB64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));

async function currentSub() {
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

// Liefert { state: 'on'|'off'|'denied'|'unsupported'|'unconfigured', hint }
export async function pushStatus() {
  if (VAPID_PUBLIC_KEY === NOT_SET) return { state: 'unconfigured', hint: 'Noch nicht eingerichtet.' };
  if (!pushSupported()) {
    return { state: 'unsupported', hint: isIos() && !isStandalone()
      ? 'Auf dem iPhone: Tippe auf Teilen und dann Zum Home-Bildschirm. Dann geht es.'
      : 'Dein Browser kann keine Mitteilungen. Die App zeigt Erinnerungen trotzdem selbst.' };
  }
  if (Notification.permission === 'denied') {
    return { state: 'denied', hint: 'Mitteilungen sind blockiert. Erlaube sie in den Einstellungen deines Handys oder Browsers.' };
  }
  try {
    const sub = await currentSub();
    return { state: sub && Notification.permission === 'granted' ? 'on' : 'off', hint: '' };
  } catch { return { state: 'off', hint: '' }; }
}

export async function enablePush() {
  const st = await pushStatus();
  if (st.state === 'unconfigured' || st.state === 'unsupported' || st.state === 'denied') throw new Error(st.hint);
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Ohne Erlaubnis gibt es keine Mitteilungen.');
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyToBytes(VAPID_PUBLIC_KEY) });
  await call('save_push_subscription', {
    p_endpoint: sub.endpoint, p_p256dh: toB64(sub.getKey('p256dh')), p_auth: toB64(sub.getKey('auth')),
    p_user_agent: navigator.userAgent.slice(0, 300),
  });
}

export async function disablePush() {
  const sub = await currentSub();
  if (!sub) return;
  try { await call('remove_push_subscription', { p_endpoint: sub.endpoint }); } catch { /* egal */ }
  await sub.unsubscribe();
}
