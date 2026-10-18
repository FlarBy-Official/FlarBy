import { sb, state, el, esc, toast, openModal, confirmDialog, call, nameHtml } from '../core.js';
import { roleLabel } from './roles.js';
import { avatarEl, avatarEditor } from '../avatar.js';
import { openAvatarReport } from './report.js';

export async function openChatInfo(chatId) {
  const body = el('div', { class: 'chatinfo' }, el('p', { class: 'muted' }, 'Lade …'));
  const m = openModal('Chatinfo', body, { wide: true });
  try { await render(); } catch (e) { body.replaceChildren(el('p', { class: 'error' }, e.message)); }

  async function render() {
    const me = state.me?.id;
    const [{ data: chat, error: e1 }, { data: members, error: e2 }, { data: roles }] = await Promise.all([
      sb.from('chats').select('*').eq('id', chatId).single(),
      sb.from('chat_members').select('user_id, role_id').eq('chat_id', chatId),
      sb.from('chat_roles').select('*').eq('chat_id', chatId).order('position'),
    ]);
    if (e1 || e2) throw new Error((e1 || e2).message);
    const ids = members.map(x => x.user_id);
    const { data: profs } = await sb.from('profiles_public').select('*').in('id', ids);
    const pmap = Object.fromEntries((profs || []).map(p => [p.id, p]));
    const rmap = Object.fromEntries((roles || []).map(r => [r.id, r]));

    if (chat.type === 'direct') return renderDirect(chat, members, pmap, me);

    const mine = members.find(x => x.user_id === me);
    const perms = rmap[mine?.role_id]?.permissions || {};
    const can = k => !!perms[k];
    const nodes = [];

    const name = el('input', { type: 'text', maxlength: 60, value: chat.name || '', disabled: !can('edit_chat_info') });
    const head = el('div', { class: 'info-head' },
      avatarEl({ url: chat.avatar_url, name: chat.name, seed: chatId, cls: 'lg' }),
      el('label', { class: 'field' }, 'Gruppenname', name));
    if (chat.verified) head.append(el('span', { class: 'verified', title: 'Verifiziert' }, '✔'));
    nodes.push(head);
    if (can('edit_chat_info')) {
      nodes.push(avatarEditor({ value: chat.avatar_url, name: chat.name, seed: chatId, prefix: `c/${chatId}`,
        save: v => call('set_chat_avatar', { p_chat_id: chatId, p_value: v }), onChange: () => window.dispatchEvent(new CustomEvent('flarchat:avatar-changed')) }));
      if (chat.avatar_removed_reason) nodes.push(el('p', { class: 'avatar-notice' }, 'Das Team hat das Gruppenavatar entfernt. Grund: ' + chat.avatar_removed_reason));
    } else if (chat.avatar_url) {
      nodes.push(el('div', { class: 'row' }, el('button', { class: 'btn ghost small', onclick: () => openAvatarReport('chat', chatId) }, '🚩 Avatar melden')));
    }
    if (can('edit_chat_info')) nodes.push(el('div', { class: 'row end' }, el('button', { class: 'btn', onclick: async () => {
      try { await call('update_chat', { p_chat_id: chatId, p_name: name.value.trim(), p_avatar_url: null }); toast('Gespeichert.'); await render(); }
      catch (e) { toast(e.message); }
    } }, 'Speichern')));

    if (can('invite_members') || can('manage_roles')) {
      const row = el('div', { class: 'row' });
      if (can('invite_members')) row.append(el('button', { class: 'btn', onclick: async () => (await import('./invite.js')).openInvite(chatId) }, 'Einladen'));
      if (can('manage_roles')) row.append(el('button', { class: 'btn ghost', onclick: async () => { (await import('./roles.js')).openRoles(chatId); } }, 'Rollen verwalten'));
      nodes.push(row);
    }

    if (chat.pinned_message_id) {
      const row = el('div', { class: 'list-row' }, el('span', { class: 'grow' }, '📌 Eine Nachricht ist angepinnt.'));
      if (can('pin_messages')) row.append(el('button', { class: 'btn ghost small', onclick: async () => {
        try { await call('pin_message', { p_chat_id: chatId, p_message_id: null }); toast('Pin gelöst.'); await render(); } catch (e) { toast(e.message); }
      } }, 'Pin lösen'));
      nodes.push(row);
    }

    nodes.push(el('h4', {}, `Mitglieder (${members.length})`));
    for (const mem of members) {
      const p = pmap[mem.user_id] || { username: '?' };
      const r = rmap[mem.role_id];
      const isOwner = r?.system_key === 'owner';
      const line = el('div', { class: 'list-row' });
      const lab = el('span', { class: 'grow' });
      line.append(avatarEl({ url: p.avatar_url, name: p.display_name || p.username, seed: mem.user_id, cls: 'sm' }));
      lab.innerHTML = `${nameHtml(p)}${mem.user_id === me ? ' (du)' : ''} <span class="role-chip" style="--c:${esc(r?.color || '#888')}">${esc(roleLabel(r))}</span>`;
      line.append(lab);
      if (mem.user_id !== me && p.avatar_url) line.append(el('button', { class: 'btn ghost small', title: 'Avatar melden', onclick: () => openAvatarReport('user', mem.user_id) }, '🚩'));
      if (mem.user_id !== me && !isOwner) {
        if (can('assign_roles')) {
          const sel = el('select', { 'aria-label': 'Rolle' }, (roles || []).filter(x => x.system_key !== 'owner')
            .map(x => el('option', { value: x.id, selected: x.id === mem.role_id }, roleLabel(x))));
          sel.addEventListener('change', async () => {
            try { await call('set_member_role', { p_chat_id: chatId, p_user_id: mem.user_id, p_role_id: sel.value }); toast('Rolle geändert.'); await render(); }
            catch (e) { toast(e.message); await render(); }
          });
          line.append(sel);
        }
        if (can('remove_members')) line.append(el('button', { class: 'btn ghost small', onclick: async () => {
          if (!await confirmDialog(`${p.display_name || p.username} aus der Gruppe entfernen?`, 'Entfernen')) return;
          try { await call('remove_member', { p_chat_id: chatId, p_user_id: mem.user_id }); await render(); } catch (e) { toast(e.message); }
        } }, 'Entfernen'));
        if (can('transfer_ownership')) line.append(el('button', { class: 'btn ghost small', onclick: async () => {
          if (!await confirmDialog(`Eigentum an ${p.display_name || p.username} übertragen? Du wirst Admin.`, 'Übertragen')) return;
          try { await call('transfer_ownership', { p_chat_id: chatId, p_user_id: mem.user_id }); toast('Eigentum übertragen.'); await render(); } catch (e) { toast(e.message); }
        } }, 'Eigentum'));
      }
      nodes.push(line);
    }

    const foot = el('div', { class: 'row end' }, el('button', { class: 'btn danger', onclick: async () => {
      if (!await confirmDialog('Gruppe wirklich verlassen?', 'Verlassen')) return;
      try { await call('leave_chat', { p_chat_id: chatId }); m.close(); toast('Gruppe verlassen.'); window.dispatchEvent(new CustomEvent('flarchat:chat-left', { detail: { chatId } })); }
      catch (e) { toast(e.message); }
    } }, 'Gruppe verlassen'));
    if (can('delete_chat')) foot.append(el('button', { class: 'btn danger', onclick: async () => {
      if (!await confirmDialog('Gruppe für alle endgültig löschen?', 'Löschen')) return;
      try { await call('delete_chat', { p_chat_id: chatId }); m.close(); toast('Gruppe gelöscht.'); window.dispatchEvent(new CustomEvent('flarchat:chat-left', { detail: { chatId } })); }
      catch (e) { toast(e.message); }
    } }, 'Gruppe löschen'));
    nodes.push(foot);
    body.replaceChildren(...nodes);
  }

  function renderDirect(chat, members, pmap, me) {
    const peer = pmap[members.find(x => x.user_id !== me)?.user_id] || { username: '?' };
    const title = el('h3', {});
    title.innerHTML = nameHtml(peer);
    body.replaceChildren(
      el('div', { class: 'info-head' },
        avatarEl({ url: peer.avatar_url, name: peer.display_name || peer.username, seed: peer.id, cls: 'lg' }),
        el('div', {}, title, el('div', { class: 'muted' }, '@' + (peer.username || '')))),
      peer.avatar_url && peer.id ? el('div', { class: 'row' }, el('button', { class: 'btn ghost small', onclick: () => openAvatarReport('user', peer.id) }, '🚩 Avatar melden')) : '',
      el('div', { class: 'row end' }, el('button', { class: 'btn danger', onclick: async () => {
        if (!await confirmDialog('Chat verlassen und aus deiner Liste entfernen?', 'Entfernen')) return;
        try { await call('leave_chat', { p_chat_id: chatId }); m.close(); window.dispatchEvent(new CustomEvent('flarchat:chat-left', { detail: { chatId } })); }
        catch (e) { toast(e.message); }
      } }, 'Chat entfernen')));
  }
}
