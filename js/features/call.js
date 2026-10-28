// Sprach- und Videoanrufe (WebRTC). Die Absprache läuft über Supabase Realtime (Broadcast), es wird nichts gespeichert.
import { sb, state, el, toast } from '../core.js';

const ICE = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] };
const RING_MS = 45000;

const out = new Map(); // Kanäle zu anderen Nutzern (zum Senden)
let inbox = null;
let call = null; // laufender Anruf

function channelTo(userId) {
  if (out.has(userId)) return out.get(userId);
  const ch = sb.channel('calls-' + userId, { config: { broadcast: { self: false } } });
  const ready = new Promise(res => ch.subscribe(s => { if (s === 'SUBSCRIBED') res(); }));
  const entry = { ch, ready };
  out.set(userId, entry);
  return entry;
}
async function sendTo(userId, event, payload) {
  const { ch, ready } = channelTo(userId);
  await ready;
  await ch.send({ type: 'broadcast', event, payload: { ...payload, from: state.me.id } });
}

// ---------- Klingelton ----------
let ringTimer = null, actx = null;
function startRing() {
  stopRing();
  const beep = () => {
    try {
      actx = actx || new AudioContext();
      const o = actx.createOscillator(), g = actx.createGain();
      o.frequency.value = 480; g.gain.value = 0.15;
      o.connect(g); g.connect(actx.destination);
      o.start(); o.stop(actx.currentTime + 0.4);
    } catch { /* kein Ton möglich */ }
    navigator.vibrate?.(300);
  };
  beep();
  ringTimer = setInterval(beep, 1500);
}
function stopRing() { clearInterval(ringTimer); ringTimer = null; navigator.vibrate?.(0); }

// ---------- Oberfläche ----------
function showScreen(name, statusText, buttons) {
  document.getElementById('call-screen')?.remove();
  const status = el('div', { class: 'call-status' }, statusText);
  const screen = el('div', { id: 'call-screen', class: call?.video ? 'video' : '' },
    call?.video ? [call.remoteEl, call.localEl] : '',
    el('div', { class: 'call-icon' }, call?.video ? '📹' : '📞'),
    el('div', { class: 'call-name' }, name),
    status,
    el('div', { class: 'call-buttons' }, buttons));
  document.body.append(screen);
  return status;
}
function hideScreen() { document.getElementById('call-screen')?.remove(); }

function inCallButtons() {
  const mute = el('button', { class: 'call-btn grey', 'aria-label': 'Mikrofon an/aus' }, '🎤');
  mute.onclick = () => {
    const t = call?.local?.getAudioTracks()[0];
    if (!t) return;
    t.enabled = !t.enabled;
    mute.textContent = t.enabled ? '🎤' : '🔇';
  };
  const btns = [mute];
  if (call?.video) {
    const cam = el('button', { class: 'call-btn grey', 'aria-label': 'Kamera an/aus' }, '📹');
    cam.onclick = () => {
      const t = call?.local?.getVideoTracks()[0];
      if (!t) return;
      t.enabled = !t.enabled;
      cam.textContent = t.enabled ? '📹' : '🚫';
    };
    btns.push(cam);
  }
  return [...btns, el('button', { class: 'call-btn red', 'aria-label': 'Auflegen', onclick: () => endCall(true) }, '📵')];
}

function newCall(fields) {
  const remoteEl = el('video', { class: 'call-remote', autoplay: '', playsinline: '' });
  const localEl = el('video', { class: 'call-local', autoplay: '', playsinline: '', muted: '' });
  localEl.muted = true;
  return { connected: false, remoteEl, localEl, ...fields };
}

// Nur der Anrufer schreibt einen Eintrag in den Chat. Die Push-Nachricht dazu geht über die normale Nachrichten-Push.
function logCall() {
  if (!call.caller || !call.chatId || call.logged) return;
  call.logged = true;
  let body;
  if (call.connected) {
    const s = Math.floor((Date.now() - call.t0) / 1000);
    body = `${call.video ? '📹 Videoanruf' : '📞 Sprachanruf'} · ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} Min.`;
  } else body = `${call.video ? '📹' : '📞'} Verpasster Anruf`;
  sb.from('messages').insert({ chat_id: call.chatId, sender_id: state.me.id, body }).then(() => { }, () => { });
}

// ---------- Verbindung ----------
async function getMic(video) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Dein Gerät kann keine Anrufe machen.');
  try { return await navigator.mediaDevices.getUserMedia({ audio: true, video: video ? { facingMode: 'user' } : false }); }
  catch { throw new Error(video ? 'Kein Zugriff auf Kamera oder Mikrofon. Bitte erlaube es.' : 'Kein Zugriff auf das Mikrofon. Bitte erlaube es.'); }
}

function makePeer(peerId) {
  const pc = new RTCPeerConnection(ICE);
  const media = call.remoteEl;
  call.local.getTracks().forEach(t => pc.addTrack(t, call.local));
  pc.ontrack = e => { media.srcObject = e.streams[0]; media.play().catch(() => { }); };
  pc.onicecandidate = e => { if (e.candidate) sendTo(peerId, 'signal', { callId: call.id, kind: 'ice', data: e.candidate }).catch(() => { }); };
  pc.onconnectionstatechange = () => {
    if (!call || call.pc !== pc) return;
    if (pc.connectionState === 'connected') onConnected();
    else if (['failed', 'closed'].includes(pc.connectionState)) endCall(false, 'Verbindung verloren.');
    else if (pc.connectionState === 'disconnected') {
      setTimeout(() => { if (call?.pc === pc && pc.connectionState === 'disconnected') endCall(true, 'Verbindung verloren.'); }, 8000);
    }
  };
  call.pc = pc;
  call.pendingIce = [];
  return pc;
}

function onConnected() {
  if (call.connected) return;
  call.connected = true;
  call.t0 = Date.now();
  if (call.video) call.localEl.srcObject = call.local;
  clearTimeout(call.ringTimeout);
  stopRing();
  const t0 = call.t0;
  const status = showScreen(call.name, '00:00', inCallButtons());
  call.timer = setInterval(() => {
    const s = Math.floor((Date.now() - t0) / 1000);
    status.textContent = String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }, 1000);
}

async function addIce(c) {
  if (!call?.pc) return;
  if (!call.pc.remoteDescription) { call.pendingIce.push(c); return; }
  try { await call.pc.addIceCandidate(c); } catch { /* alter Kandidat */ }
}
async function flushIce() {
  const list = call.pendingIce.splice(0);
  for (const c of list) { try { await call.pc.addIceCandidate(c); } catch { /* alter Kandidat */ } }
}

function cleanup() {
  if (!call) return;
  logCall();
  clearInterval(call.timer);
  clearTimeout(call.ringTimeout);
  stopRing();
  call.local?.getTracks().forEach(t => t.stop());
  call.remoteEl.srcObject = null;
  call.localEl.srcObject = null;
  try { call.pc?.close(); } catch { /* egal */ }
  call = null;
  hideScreen();
}

function endCall(notify, message) {
  if (!call) return;
  const { peerId, id } = call;
  if (notify) sendTo(peerId, 'hangup', { callId: id }).catch(() => { });
  cleanup();
  if (message) toast(message);
}

// ---------- Anrufen ----------
export async function startCall(peerId, peerName, chatId, video = false) {
  if (call) { toast('Du bist schon in einem Anruf.'); return; }
  const id = crypto.randomUUID();
  call = newCall({ id, peerId, name: peerName, caller: true, chatId, video });
  try {
    call.local = await getMic(video);
  } catch (e) { call = null; toast(e.message); return; }
  showScreen(peerName, 'Klingelt …', [el('button', { class: 'call-btn red', 'aria-label': 'Auflegen', onclick: () => endCall(true) }, '📵')]);
  call.ringTimeout = setTimeout(() => endCall(true, 'Niemand hat abgenommen.'), RING_MS);
  try {
    await sendTo(peerId, 'invite', { callId: id, video, name: state.pub?.display_name || state.pub?.username || 'Jemand' });
  } catch { endCall(false, 'Anruf konnte nicht gestartet werden.'); }
}

// ---------- Empfangen ----------
async function onInvite(p) {
  if (call) { sendTo(p.from, 'busy', { callId: p.callId }).catch(() => { }); return; }
  call = newCall({ id: p.callId, peerId: p.from, name: p.name || 'Jemand', caller: false, video: !!p.video });
  startRing();
  call.ringTimeout = setTimeout(() => endCall(false), RING_MS);
  const accept = el('button', { class: 'call-btn green', 'aria-label': 'Annehmen' }, '📞');
  const decline = el('button', { class: 'call-btn red', 'aria-label': 'Ablehnen' }, '📵');
  showScreen(call.name, call.video ? 'Videoanruf …' : 'ruft dich an …', [decline, accept]);
  decline.onclick = () => { sendTo(p.from, 'decline', { callId: p.callId }).catch(() => { }); cleanup(); };
  accept.onclick = async () => {
    if (!call || call.id !== p.callId) return;
    stopRing();
    try { call.local = await getMic(call.video); }
    catch (e) { sendTo(p.from, 'decline', { callId: p.callId }).catch(() => { }); cleanup(); toast(e.message); return; }
    showScreen(call.name, 'Verbinde …', inCallButtons());
    makePeer(p.from);
    try { await sendTo(p.from, 'accept', { callId: p.callId }); }
    catch { endCall(false, 'Verbindung fehlgeschlagen.'); }
  };
}

async function onSignal(p) {
  if (!call || call.id !== p.callId || call.peerId !== p.from) return;
  try {
    if (p.kind === 'ice') return await addIce(p.data);
    if (p.kind === 'offer' && !call.caller) {
      await call.pc.setRemoteDescription(p.data);
      await flushIce();
      const ans = await call.pc.createAnswer();
      await call.pc.setLocalDescription(ans);
      await sendTo(call.peerId, 'signal', { callId: call.id, kind: 'answer', data: call.pc.localDescription.toJSON() });
    } else if (p.kind === 'answer' && call.caller) {
      await call.pc.setRemoteDescription(p.data);
      await flushIce();
    }
  } catch { endCall(true, 'Verbindung fehlgeschlagen.'); }
}

async function onAccept(p) {
  if (!call || call.id !== p.callId || !call.caller || call.pc) return;
  showScreen(call.name, 'Verbinde …', inCallButtons());
  try {
    const pc = makePeer(call.peerId);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await sendTo(call.peerId, 'signal', { callId: call.id, kind: 'offer', data: pc.localDescription.toJSON() });
  } catch { endCall(true, 'Verbindung fehlgeschlagen.'); }
}

export function initCalls() {
  if (inbox || !window.RTCPeerConnection) return;
  const same = p => call && call.id === p.callId && call.peerId === p.from;
  inbox = sb.channel('calls-' + state.me.id, { config: { broadcast: { self: false } } })
    .on('broadcast', { event: 'invite' }, ({ payload }) => onInvite(payload))
    .on('broadcast', { event: 'accept' }, ({ payload }) => onAccept(payload))
    .on('broadcast', { event: 'signal' }, ({ payload }) => onSignal(payload))
    .on('broadcast', { event: 'decline' }, ({ payload }) => { if (same(payload)) endCall(false, 'Anruf wurde abgelehnt.'); })
    .on('broadcast', { event: 'busy' }, ({ payload }) => { if (same(payload)) endCall(false, 'Besetzt. Die Person telefoniert gerade.'); })
    .on('broadcast', { event: 'hangup' }, ({ payload }) => {
      if (!same(payload)) return;
      const missed = !call.caller && !call.connected;
      endCall(false, missed ? 'Verpasster Anruf von ' + call.name : 'Anruf beendet.');
    })
    .subscribe();
}
