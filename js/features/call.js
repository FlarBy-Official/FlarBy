// Sprach- und Videoanrufe (WebRTC), auch in Gruppen. Jeder ist direkt mit jedem verbunden (Mesh).
// Die Absprache läuft über Supabase Realtime (Broadcast), es wird nichts gespeichert.
import { sb, state, el, toast } from '../core.js';

const ICE = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] };
const RING_MS = 45000;
const JOIN_MS = 10000;
const MAX_PEOPLE = 6;

const out = new Map(); // Kanäle zu anderen Nutzern (zum Senden)
let inbox = null;
let call = null; // laufender Anruf

const myId = () => state.me.id;
const myName = () => state.pub?.display_name || state.pub?.username || 'Jemand';

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
  await ch.send({ type: 'broadcast', event, payload: { ...payload, from: myId(), fromName: myName() } });
}
const others = () => call.members.filter(u => u !== myId());
const sendAll = (event, payload) => others().forEach(u => sendTo(u, event, payload).catch(() => { }));

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
function buttons() {
  if (!call.joined) {
    if (call.initiator) return [hangupBtn()];
    const accept = el('button', { class: 'call-btn green', 'aria-label': 'Annehmen', onclick: acceptCall }, '📞');
    const decline = el('button', { class: 'call-btn red', 'aria-label': 'Ablehnen', onclick: declineCall }, '📵');
    return [decline, accept];
  }
  const mic = call.local?.getAudioTracks()[0];
  const mute = el('button', { class: 'call-btn grey', 'aria-label': 'Mikrofon an/aus' }, mic && !mic.enabled ? '🔇' : '🎤');
  mute.onclick = () => {
    if (!mic) return;
    mic.enabled = !mic.enabled;
    mute.textContent = mic.enabled ? '🎤' : '🔇';
  };
  const list = [mute];
  if (call.video) {
    const cam = call.local?.getVideoTracks()[0];
    const b = el('button', { class: 'call-btn grey', 'aria-label': 'Kamera an/aus' }, cam && !cam.enabled ? '🚫' : '📹');
    b.onclick = () => {
      if (!cam) return;
      cam.enabled = !cam.enabled;
      b.textContent = cam.enabled ? '📹' : '🚫';
    };
    list.push(b);
  }
  return [...list, hangupBtn()];
}
const hangupBtn = () => el('button', { class: 'call-btn red', 'aria-label': 'Auflegen', onclick: () => endCall(true) }, '📵');

function draw() {
  document.getElementById('call-screen')?.remove();
  if (!call) return;
  const peers = [...call.peers.values()];
  const showVideo = call.video && call.joined;
  const statusEl = el('div', { class: 'call-status' }, call.status || '');
  call.statusEl = statusEl;
  const screen = el('div', { id: 'call-screen', class: showVideo ? 'video' : '' },
    showVideo ? el('div', { class: 'call-grid n' + Math.min(Math.max(peers.length, 1), 4) },
      peers.map(p => el('div', { class: 'call-tile' }, p.el, el('div', { class: 'call-tile-name' }, p.name)))) : '',
    showVideo ? call.localEl : '',
    el('div', { class: 'call-info' },
      el('div', { class: 'call-icon' }, call.video ? '📹' : '📞'),
      el('div', { class: 'call-name' }, call.name),
      statusEl,
      call.joined && !showVideo && peers.length ? el('div', { class: 'call-status' }, 'Mit: ' + peers.map(p => p.name).join(', ')) : ''),
    el('div', { class: 'call-buttons' }, buttons()));
  document.body.append(screen);
  if (showVideo) {
    call.localEl.srcObject = call.local;
    call.localEl.play().catch(() => { });
    peers.forEach(p => p.el.play?.().catch(() => { })); // Das Verschieben im Dokument pausiert Videos
  }
}
function setStatus(text) {
  if (!call) return;
  call.status = text;
  if (call.statusEl) call.statusEl.textContent = text;
}

// ---------- Hilfen ----------
async function getMedia(video) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Dein Gerät kann keine Anrufe machen.');
  try { return await navigator.mediaDevices.getUserMedia({ audio: true, video: video ? { facingMode: 'user' } : false }); }
  catch { throw new Error(video ? 'Kein Zugriff auf Kamera oder Mikrofon. Bitte erlaube es.' : 'Kein Zugriff auf das Mikrofon. Bitte erlaube es.'); }
}

function newCall(fields) {
  const localEl = el('video', { class: 'call-local', autoplay: '', playsinline: '' });
  localEl.muted = true;
  return { joined: false, connected: false, hadPeer: false, peers: new Map(), waiting: new Set(), localEl, status: '', ...fields };
}

// Nur der Anrufer schreibt einen Eintrag in den Chat. Die Push-Nachricht dazu geht über die normale Nachrichten-Push.
function logCall() {
  if (!call.initiator || !call.chatId || call.logged) return;
  call.logged = true;
  const icon = call.video ? '📹' : '📞';
  let body;
  if (call.t0) {
    const s = Math.floor((Date.now() - call.t0) / 1000);
    const kind = call.isGroup ? 'Gruppenanruf' : call.video ? 'Videoanruf' : 'Sprachanruf';
    body = `${icon} ${kind} · ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} Min.`;
  } else body = `${icon} Verpasster Anruf`;
  sb.from('messages').insert({ chat_id: call.chatId, sender_id: myId(), body }).then(() => { }, () => { });
}

function cleanup() {
  if (!call) return;
  logCall();
  clearInterval(call.timer);
  clearTimeout(call.ringTimeout);
  clearTimeout(call.joinTimeout);
  stopRing();
  for (const p of call.peers.values()) closePeer(p);
  call.local?.getTracks().forEach(t => t.stop());
  call.localEl.srcObject = null;
  call = null;
  document.getElementById('call-screen')?.remove();
}

function endCall(notify, message) {
  if (!call) return;
  if (notify) sendAll('hangup', { callId: call.id });
  cleanup();
  if (message) toast(message);
}

// ---------- Verbindungen zu den anderen ----------
function closePeer(p) {
  p.el.srcObject = null;
  try { p.pc.close(); } catch { /* egal */ }
}

function ensurePeer(uid, name, offer) {
  let p = call.peers.get(uid);
  if (p) return p;
  if (call.peers.size >= MAX_PEOPLE - 1) return null;
  const pc = new RTCPeerConnection(ICE);
  const media = call.video ? el('video', { class: 'call-remote', autoplay: '', playsinline: '' }) : new Audio();
  media.autoplay = true;
  p = { uid, name: name || 'Jemand', pc, el: media, pendingIce: [], connected: false };
  call.peers.set(uid, p);
  call.hadPeer = true;
  call.waiting.delete(uid);
  clearTimeout(call.joinTimeout);
  call.local.getTracks().forEach(t => pc.addTrack(t, call.local));
  pc.ontrack = e => { media.srcObject = e.streams[0]; media.play().catch(() => { }); };
  pc.onicecandidate = e => {
    if (e.candidate) sendTo(uid, 'signal', { callId: call.id, kind: 'ice', data: e.candidate }).catch(() => { });
  };
  pc.onconnectionstatechange = () => {
    if (!call || call.peers.get(uid) !== p) return;
    if (pc.connectionState === 'connected') { p.connected = true; onConnected(); }
    else if (['failed', 'closed'].includes(pc.connectionState)) dropPeer(uid, 'Verbindung verloren.');
    else if (pc.connectionState === 'disconnected') {
      setTimeout(() => { if (call?.peers.get(uid) === p && pc.connectionState === 'disconnected') dropPeer(uid, 'Verbindung verloren.'); }, 8000);
    }
  };
  if (offer) {
    (async () => {
      try {
        await pc.setLocalDescription(await pc.createOffer());
        await sendTo(uid, 'signal', { callId: call.id, kind: 'offer', data: pc.localDescription.toJSON() });
      } catch { dropPeer(uid, 'Verbindung fehlgeschlagen.'); }
    })();
  }
  draw();
  return p;
}

// Wer die kleinere ID hat, schickt das Angebot. So gibt es nie zwei Angebote gleichzeitig.
const iOffer = uid => myId() < uid;

function dropPeer(uid, message) {
  const p = call?.peers.get(uid);
  if (!p) return;
  closePeer(p);
  call.peers.delete(uid);
  if (!call.peers.size && call.hadPeer) { endCall(true, message || 'Anruf beendet.'); return; }
  draw();
}

function onConnected() {
  if (call.connected) return;
  call.connected = true;
  call.t0 = Date.now();
  clearTimeout(call.ringTimeout);
  stopRing();
  setStatus('00:00');
  call.timer = setInterval(() => {
    const s = Math.floor((Date.now() - call.t0) / 1000);
    setStatus(String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'));
  }, 1000);
}

// ---------- Anrufen ----------
export async function startCall({ chatId, memberIds, title, video = false, isGroup = false }) {
  if (call) { toast('Du bist schon in einem Anruf.'); return; }
  const targets = memberIds.filter(u => u !== myId());
  if (!targets.length) { toast('Es ist niemand zum Anrufen da.'); return; }
  call = newCall({ id: crypto.randomUUID(), chatId, members: [myId(), ...targets], isGroup, video, name: title, initiator: true, joined: true });
  try { call.local = await getMedia(video); }
  catch (e) { call = null; toast(e.message); return; }
  call.waiting = new Set(targets);
  setStatus(isGroup ? 'Klingelt bei allen …' : 'Klingelt …');
  draw();
  call.ringTimeout = setTimeout(() => { if (call && !call.peers.size) endCall(true, 'Niemand hat abgenommen.'); }, RING_MS);
  const invite = { callId: call.id, chatId, members: call.members, isGroup, video, by: myName(), title: isGroup ? title : myName() };
  try { await Promise.all(targets.map(u => sendTo(u, 'invite', invite))); }
  catch { endCall(false, 'Anruf konnte nicht gestartet werden.'); }
}

// ---------- Angerufen werden ----------
function onInvite(p) {
  if (call) { sendTo(p.from, 'busy', { callId: p.callId }).catch(() => { }); return; }
  call = newCall({ id: p.callId, chatId: p.chatId, members: p.members, isGroup: !!p.isGroup, video: !!p.video, name: p.title || p.fromName || 'Jemand', inviterId: p.from, initiator: false });
  startRing();
  call.ringTimeout = setTimeout(() => endCall(false), RING_MS);
  setStatus(call.isGroup ? `${p.by || 'Jemand'} ruft an …` : call.video ? 'Videoanruf …' : 'ruft dich an …');
  draw();
}

function declineCall() {
  if (!call) return;
  sendTo(call.inviterId, 'decline', { callId: call.id }).catch(() => { });
  cleanup();
}

async function acceptCall() {
  if (!call || call.joined) return;
  stopRing();
  clearTimeout(call.ringTimeout);
  try { call.local = await getMedia(call.video); }
  catch (e) { declineCall(); toast(e.message); return; }
  call.joined = true;
  setStatus('Verbinde …');
  draw();
  sendAll('join', { callId: call.id });
  call.joinTimeout = setTimeout(() => endCall(false, 'Der Anruf ist schon vorbei.'), JOIN_MS);
}

// ---------- Nachrichten von anderen ----------
const here = p => call && call.id === p.callId && call.joined && call.members.includes(p.from);

function onJoin(p) {
  if (!here(p)) return;
  if (!call.peers.has(p.from) && call.peers.size >= MAX_PEOPLE - 1) { sendTo(p.from, 'full', { callId: call.id }).catch(() => { }); return; }
  ensurePeer(p.from, p.fromName, iOffer(p.from));
  sendTo(p.from, 'here', { callId: call.id }).catch(() => { });
}
function onHere(p) {
  if (!here(p)) return;
  ensurePeer(p.from, p.fromName, iOffer(p.from));
}

async function onSignal(p) {
  if (!here(p)) return;
  const peer = ensurePeer(p.from, p.fromName, false);
  if (!peer) return;
  const pc = peer.pc;
  try {
    if (p.kind === 'ice') {
      if (!pc.remoteDescription) peer.pendingIce.push(p.data);
      else await pc.addIceCandidate(p.data).catch(() => { });
      return;
    }
    await pc.setRemoteDescription(p.data);
    for (const c of peer.pendingIce.splice(0)) await pc.addIceCandidate(c).catch(() => { });
    if (p.kind === 'offer') {
      await pc.setLocalDescription(await pc.createAnswer());
      await sendTo(p.from, 'signal', { callId: call.id, kind: 'answer', data: pc.localDescription.toJSON() });
    }
  } catch { dropPeer(p.from, 'Verbindung fehlgeschlagen.'); }
}

function onNo(p, text) {
  if (!call || call.id !== p.callId || !call.initiator) return;
  call.waiting.delete(p.from);
  if (!call.waiting.size && !call.peers.size) endCall(true, text);
}

function onHangup(p) {
  if (!call || call.id !== p.callId) return;
  if (call.peers.has(p.from)) { dropPeer(p.from, 'Anruf beendet.'); return; }
  if (!call.joined && p.from === call.inviterId) endCall(false, 'Verpasster Anruf von ' + call.name);
  else if (call.initiator) call.waiting.delete(p.from);
}

export function initCalls() {
  if (inbox || !window.RTCPeerConnection) return;
  inbox = sb.channel('calls-' + myId(), { config: { broadcast: { self: false } } })
    .on('broadcast', { event: 'invite' }, ({ payload }) => onInvite(payload))
    .on('broadcast', { event: 'join' }, ({ payload }) => onJoin(payload))
    .on('broadcast', { event: 'here' }, ({ payload }) => onHere(payload))
    .on('broadcast', { event: 'signal' }, ({ payload }) => onSignal(payload))
    .on('broadcast', { event: 'full' }, ({ payload }) => { if (here(payload) && !call.peers.size) endCall(false, 'Der Anruf ist voll.'); })
    .on('broadcast', { event: 'decline' }, ({ payload }) => onNo(payload, call?.isGroup ? 'Niemand hat abgenommen.' : 'Anruf wurde abgelehnt.'))
    .on('broadcast', { event: 'busy' }, ({ payload }) => onNo(payload, call?.isGroup ? 'Niemand hat abgenommen.' : 'Besetzt. Die Person telefoniert gerade.'))
    .on('broadcast', { event: 'hangup' }, ({ payload }) => onHangup(payload))
    .subscribe();
}
