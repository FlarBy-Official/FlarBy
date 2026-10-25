import { sb, state, el, nameHtml, toast, call, openModal, closeModal } from '../core.js';
import { avatarEl } from '../avatar.js';

const norm = s => String(s || '').toLowerCase().replace(/\s+/g, '');

async function roleOf(chatId, userId) {
  const { data: mem } = await sb.from('chat_members').select('role_id').eq('chat_id', chatId).eq('user_id', userId).maybeSingle();
  if (!mem) return null;
  if (!mem.role_id) return 'Mitglied';
  const { data: r } = await sb.from('chat_roles').select('name').eq('id', mem.role_id).maybeSingle();
  return r?.name || 'Mitglied';
}

function profileView(p, roleText) {
  const name = el('div', { class: 'pname' });
  name.innerHTML = nameHtml(p);
  return el('div', { class: 'profile-card' },
    avatarEl({ url: p.avatar_url, name: p.display_name || p.username, seed: p.id, cls: 'lg' }),
    name,
    el('div', { class: 'muted' }, roleText),
    p.id !== state.me.id ? el('button', {
      class: 'btn',
      onclick: async () => {
        try {
          const id = await call('start_direct', { p_user_id: p.id });
          closeModal();
          location.hash = '#/chat/' + id;
        } catch (e) { toast(e.message); }
      },
    }, '💬 Nachricht schreiben') : null);
}

async function openProfile(p, chatId) {
  const role = await roleOf(chatId, p.id);
  openModal('Profil', profileView(p, role ?? 'Nicht mehr im Chat'));
}

function memberList(title, profiles, chatId) {
  const list = el('div', {}, profiles.map(p => {
    const n = el('div', { style: 'flex:1;min-width:0' });
    n.innerHTML = nameHtml(p);
    return el('div', { class: 'member-hit', onclick: () => openProfile(p, chatId) },
      avatarEl({ url: p.avatar_url, name: p.display_name || p.username, seed: p.id, cls: 'sm' }), n);
  }));
  openModal(title, el('div', {}, el('p', { class: 'muted' }, profiles.length + (profiles.length === 1 ? ' Mitglied' : ' Mitglieder')), list));
}

async function profilesOf(ids) {
  if (!ids.length) return [];
  const { data } = await sb.from('profiles_public').select('*').in('id', ids);
  return (data || []).sort((a, b) => String(a.display_name || a.username).localeCompare(String(b.display_name || b.username)));
}

// Klick auf @name, @rolle oder @everyone in einem Chat
export async function openMention(token, chatId) {
  try {
    const name = token.replace(/^@/, '').toLowerCase();
    if (name === 'everyone') {
      const { data } = await sb.from('chat_members').select('user_id').eq('chat_id', chatId);
      return memberList('@everyone', await profilesOf((data || []).map(r => r.user_id)), chatId);
    }
    const { data: p } = await sb.from('profiles_public').select('*').eq('username', name).maybeSingle();
    if (p) {
      const role = await roleOf(chatId, p.id);
      if (role === null) {
        const { data: wrote } = await sb.from('messages').select('id').eq('chat_id', chatId).eq('sender_id', p.id).limit(1);
        if (!wrote?.length) return;
      }
      return openModal('Profil', profileView(p, role ?? 'Nicht mehr im Chat'));
    }
    const { data: roles } = await sb.from('chat_roles').select('id,name').eq('chat_id', chatId);
    const role = (roles || []).find(r => norm(r.name) === name);
    if (!role) return;
    const { data: mem } = await sb.from('chat_members').select('user_id').eq('chat_id', chatId).eq('role_id', role.id);
    memberList('@' + role.name, await profilesOf((mem || []).map(r => r.user_id)), chatId);
  } catch (e) { toast(e.message || 'Fehler'); }
}
