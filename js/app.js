import { sb, state, el, nameHtml, toast, call, openModal, KONTO_NR, knownKonten } from './core.js';
import { renderAuth, forcePasswordChange } from './auth.js';
import { mountChatList, setActiveChat, refreshChatList, refreshSoon, openNewChat } from './chatlist.js';
import { mountChat, openChat, closeChat } from './chat.js';
import { initPinLock } from './pinlock.js';
import { ensureAge, loadAgeState, openGuardianRequests } from './features/age.js';

const app = document.getElementById('app');
let enteredFor = null;
let appChannel = null;
let presenceTimer = null;

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { });

async function loadProfile(user) {
  let prof = null;
  try {
    const r = await call('my_profile');
    prof = Array.isArray(r) ? r[0] : r;
  } catch { /* Fallback unten */ }
  if (!prof) {
    const r = await sb.from('profiles').select('*').eq('id', user.id).maybeSingle();
    prof = r.data;
  }
  const pub = await sb.from('profiles_public').select('*').eq('id', user.id).maybeSingle();
  state.me = user;
  state.profile = prof;
  state.pub = pub.data || (prof ? { id: user.id, username: prof.username, display_name: prof.display_name } : null);
  return prof;
}

function showAuth(notice) {
  teardownMain();
  enteredFor = null;
  renderAuth(app, { onLogin: () => start(), notice });
}

function teardownMain() {
  closeChat();
  if (appChannel) { sb.removeChannel(appChannel); appChannel = null; }
  clearInterval(presenceTimer);
}

async function start() {
  const { data } = await sb.auth.getSession();
  const user = data.session?.user;
  if (!user) return showAuth();
  if (enteredFor === user.id) return;
  enteredFor = user.id;
  const prof = await loadProfile(user);
  if (!prof) { await sb.auth.signOut(); return showAuth('Profil nicht gefunden.'); }
  if (prof.banned) { await sb.auth.signOut(); return showAuth('Dein Zugang wurde gesperrt.'); }
  if (prof.must_change_password) {
    await forcePasswordChange(app);
    prof.must_change_password = false;
  }
  if (prof && 'agb_accepted_at' in prof && (!prof.agb_accepted_at || await agbRenewed(prof.agb_accepted_at))) {
    const ok = await askAgb();
    if (!ok) { enteredFor = null; await sb.auth.signOut(); return showAuth(); }
    prof.agb_accepted_at = new Date().toISOString();
  }
  let age = await loadAgeState();
  if (!age.verified) age = await ensureAge(app, age);
  state.age = age;
  buildMain();
  showAvatarNotice();
  showAnnouncement();
  window.addEventListener('flarchat:avatar-changed', () => refreshChatList());
}

// true, wenn der Owner die AGB nach der letzten Zustimmung erneut angefordert hat
async function agbRenewed(acceptedAt) {
  try {
    const { data } = await sb.from('app_settings').select('value').eq('key', 'agb_required_at').maybeSingle();
    return !!data?.value?.at && new Date(data.value.at) > new Date(acceptedAt);
  } catch { return false; }
}

// Blockierendes Fenster; true = zugestimmt (oder Datenbank kennt accept_agb noch nicht), false = abgemeldet
function askAgb() {
  return new Promise(resolve => {
    const cb = el('input', { type: 'checkbox', style: 'width:20px;height:20px;flex:none;accent-color:#FF2800' });
    const err = el('div', { class: 'error' });
    const next = el('button', { class: 'btn', disabled: true }, 'Weiter');
    const out = el('button', { class: 'btn ghost' }, 'Abmelden');
    const overlay = el('div', { class: 'modal-overlay' }, el('div', { class: 'modal' },
      el('div', { class: 'modal-head' }, el('strong', {}, 'AGB')),
      el('div', { class: 'modal-body' },
        el('p', {}, 'Wir haben unsere AGB. Bitte lies sie und stimme zu.'),
        el('p', {}, el('a', { href: 'agb.html', target: '_blank', rel: 'noopener' }, 'AGB lesen')),
        el('label', { style: 'display:flex;align-items:flex-start;gap:8px;margin:10px 0;cursor:pointer' }, cb,
          el('span', {}, 'Ich habe die AGB gelesen und stimme zu.')),
        err,
        el('div', { class: 'row end' }, out, next))));
    cb.addEventListener('change', () => { next.disabled = !cb.checked; });
    next.addEventListener('click', async () => {
      next.disabled = true; err.textContent = '';
      try { await call('accept_agb'); }
      catch (x) {
        if (!/accept_agb|schema cache|does not exist/i.test(x.message)) {
          err.textContent = 'Das hat nicht geklappt. Versuche es noch einmal.'; next.disabled = !cb.checked; return;
        }
      }
      overlay.remove(); resolve(true);
    });
    out.addEventListener('click', () => { overlay.remove(); resolve(false); });
    document.body.append(overlay);
  });
}

function buildMain() {
  const list = el('div', { id: 'chatlist' });
  const search = el('input', { type: 'search', placeholder: 'Suchen …' });
  const nameEl = el('div', { class: 'title' });
  const refreshName = () => { nameEl.innerHTML = nameHtml(state.pub) || 'FlarChat'; };
  refreshName();
  const sidebar = el('aside', { id: 'sidebar' },
    el('div', { class: 'topbar' }, el('img', { src: 'icons/icon.svg', width: '30', height: '30', alt: '' }), nameEl,
      el('button', { class: 'icon-btn', title: 'Neuer Chat', 'aria-label': 'Neuer Chat', onclick: openNewChat }, '＋'),
      el('button', { class: 'icon-btn', title: 'Menü', 'aria-label': 'Menü', onclick: e => { e.stopPropagation(); toggleMenu(sidebar); } }, '⋮')),
    dashboardBar(),
    el('div', { class: 'searchbar' }, search), list);
  const pane = el('section', { id: 'chatpane' });
  app.replaceChildren(el('div', { id: 'main' }, sidebar, pane));
  document.addEventListener('click', () => sidebar.querySelector('.dropdown')?.remove());

  mountChat(pane);
  mountChatList(list, search);
  route();

  appChannel = sb.channel('app-changes');
  for (const table of ['messages', 'chat_members', 'chats']) {
    appChannel.on('postgres_changes', { event: '*', schema: 'public', table }, () => refreshSoon());
  }
  appChannel.on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'profiles', filter: `id=eq.${state.me.id}` },
    async () => { await loadProfile(state.me); refreshName(); });
  appChannel.subscribe();

  const info = {
    ua: navigator.userAgent, lang: navigator.language, tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    screen: `${screen.width}x${screen.height}`,
    standalone: matchMedia('(display-mode: standalone)').matches || navigator.standalone === true,
  };
  call('record_login', { p_info: info }).catch(() => call('record_login_ip').catch(() => { }));
  let errCount = 0;
  const report = (message, stack) => {
    if (errCount++ >= 5) return;
    call('log_client_error', { p_message: String(message), p_stack: stack ? String(stack) : null, p_url: location.href, p_ua: navigator.userAgent }).catch(() => { });
  };
  window.addEventListener('error', e => report(e.message, e.error?.stack));
  window.addEventListener('unhandledrejection', e => report(e.reason?.message || e.reason, e.reason?.stack));
  const ping = () => call('touch_presence').catch(() => { });
  ping();
  presenceTimer = setInterval(ping, 60000);
  import('./features/reminders.js').then(m => m.startReminders()).catch(() => { });
  import('./features/call.js').then(m => m.initCalls()).catch(() => { });
}

// Große Knöpfe für Team und Owner, ganz oben in der Seitenleiste
function dashboardBar() {
  const role = state.profile?.global_role;
  if (!['moderator', 'admin', 'owner'].includes(role)) return null;
  const safe = fn => async () => { try { await fn(); } catch (e) { toast('Nicht verfügbar: ' + (e.message || e)); } };
  return el('div', { class: 'dashbar' },
    role === 'owner'
      ? el('button', { class: 'btn dark', onclick: safe(async () => (await import('./admin.js')).openAdmin()) }, '🔐 Admin-Panel')
      : el('button', { class: 'btn', onclick: safe(async () => (await import('./features/team.js')).openTeamPanel()) }, '🛡 Team-Bereich'));
}

function toggleMenu(sidebar) {
  const old = sidebar.querySelector('.dropdown');
  if (old) return old.remove();
  const role = state.profile?.global_role;
  const items = [['⚙ Einstellungen', async () => (await import('./features/settings.js')).openSettings()]];
  items.push(['🌓 Dunkelmodus umschalten', async () => {
    const s = await import('./features/settings.js');
    s.applyTheme(s.isDark() ? 'light' : 'dark');
  }]);
  if (state.age?.is_guardian) items.push(['👪 Bürgen-Anfragen', () => openGuardianRequests()]);
  if (role === 'owner') {
    items.push(['🔐 Admin-Panel', () => import('./admin.js').then(m => m.openAdmin())]);
  }
  else if (['moderator', 'admin'].includes(role)) {
    items.push(['🛡 Team-Bereich', async () => (await import('./features/team.js')).openTeamPanel()]);
  }
  const konten = knownKonten();
  for (const k of konten) {
    if (k.nr === KONTO_NR) continue;
    items.push([`👥 Konto ${k.nr}${k.name ? ' (@' + k.name + ')' : ''} (neuer Tab)`,
      () => { window.open(location.pathname + '?konto=' + k.nr, '_blank'); }]);
  }
  items.push(['➕ Neues Konto (neuer Tab)', () => {
    let n = 1;
    while (konten.some(k => Number(k.nr) === n) && n < 99) n++;
    window.open(location.pathname + '?konto=' + n, '_blank');
  }]);
  items.push(['Abmelden', () => sb.auth.signOut()]);
  sidebar.append(el('div', { class: 'dropdown' }, items.map(([label, fn]) =>
    el('button', { onclick: async () => { try { await fn(); } catch (e) { toast('Nicht verfügbar: ' + (e.message || e)); } } }, label))));
}

function route() {
  const m = location.hash.match(/^#\/chat\/([0-9a-f-]{36})$/i);
  if (m) { setActiveChat(m[1]); openChat(m[1]); }
  else { setActiveChat(null); closeChat(); }
}
window.addEventListener('hashchange', () => { if (enteredFor && document.getElementById('chatpane')) route(); });

sb.auth.onAuthStateChange((event) => {
  if (event === 'SIGNED_OUT') showAuth();
});

initPinLock(async () => { await sb.auth.signOut(); localStorage.removeItem('fc_pin'); document.getElementById('pinlock')?.remove(); });
start().catch(e => { console.error(e); showAuth('Verbindungsproblem. Bitte später erneut versuchen.'); });

// iPhone: Bei geöffneter Tastatur wird die sichtbare Höhe kleiner, damit das Eingabefeld sichtbar bleibt
if (window.visualViewport) {
  const fit = () => {
    document.documentElement.style.setProperty('--vvh', window.visualViewport.height + 'px');
    window.scrollTo(0, 0);
  };
  window.visualViewport.addEventListener('resize', fit);
  window.visualViewport.addEventListener('scroll', fit);
  fit();
}

// Einmaliger Hinweis, wenn das Team das Avatar entfernt hat
async function showAvatarNotice() {
  try {
    const r = await call('my_avatar_state');
    const st = Array.isArray(r) ? r[0] : r;
    if (!st?.notice) return;
    const m = openModal('Hinweis vom Team', el('div', {},
      el('p', {}, st.notice),
      st.locked ? el('p', { class: 'muted' }, 'Du kannst im Moment kein Avatar mehr einstellen.') : '',
      el('div', { class: 'row end' }, el('button', { class: 'btn', onclick: () => m.close() }, 'Verstanden'))));
    await call('clear_avatar_notice');
  } catch { /* nicht schlimm */ }
}

async function showAnnouncement() {
  try {
    const { data } = await sb.from('app_settings').select('value').eq('key', 'announcement').maybeSingle();
    const a = data?.value;
    if (!a?.text || localStorage.getItem('flarchat-announce') === a.id) return;
    const m = openModal('📢 Ansage', el('div', {},
      el('p', {}, a.text),
      el('div', { class: 'row end' }, el('button', { class: 'btn', onclick: () => { localStorage.setItem('flarchat-announce', a.id); m.close(); } }, 'Verstanden'))));
  } catch { /* nicht schlimm */ }
}
