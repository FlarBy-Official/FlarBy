import { sb, state, el, nameHtml, toast, call } from './core.js';
import { renderAuth, forcePasswordChange } from './auth.js';
import { mountChatList, setActiveChat, refreshChatList, refreshSoon, openNewChat } from './chatlist.js';
import { mountChat, openChat, closeChat } from './chat.js';
import { initPinLock } from './pinlock.js';

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
  buildMain();
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

  const ping = () => call('touch_presence').catch(() => { });
  ping();
  presenceTimer = setInterval(ping, 60000);
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
  if (['moderator', 'admin', 'owner'].includes(role)) {
    items.push(['🛡 Team-Bereich', async () => (await import('./features/team.js')).openTeamPanel()]);
  }
  if (role === 'owner') items.push(['🔐 Admin-Bereich', () => { location.href = 'admin.html'; }]);
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
