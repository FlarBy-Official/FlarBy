import { sb, el, toast, openModal, confirmDialog, call } from '../core.js';

// Einzige Stelle für Chat-Rechte: hier ergänzen, die UI passt sich an.
export const RIGHTS = [
  ['send_messages', 'Nachrichten senden'],
  ['send_media', 'Bilder senden'],
  ['delete_others_messages', 'Fremde Nachrichten löschen'],
  ['invite_members', 'Mitglieder einladen'],
  ['remove_members', 'Mitglieder entfernen'],
  ['assign_roles', 'Rollen zuweisen'],
  ['edit_chat_info', 'Chat-Name und -Bild ändern'],
  ['pin_messages', 'Nachrichten anpinnen'],
  ['delete_chat', 'Chat löschen'],
  ['transfer_ownership', 'Eigentum übertragen'],
  ['manage_roles', 'Rollen verwalten'],
];

const SYS_LABEL = { owner: 'Besitzer', admin: 'Admin', member: 'Mitglied' };
export const roleLabel = r => (r && r.is_system ? SYS_LABEL[r.system_key] || r.name : r?.name || '');

export async function openRoles(chatId) {
  const body = el('div', { class: 'roles-wrap' });
  const m = openModal('Rollen verwalten', body, { wide: true });

  async function load() {
    body.replaceChildren(el('p', { class: 'muted' }, 'Lade …'));
    const { data, error } = await sb.from('chat_roles').select('*').eq('chat_id', chatId).order('position');
    if (error) { body.replaceChildren(el('p', { class: 'error' }, error.message)); return; }
    renderList(data || []);
  }

  function renderList(roles) {
    body.replaceChildren(
      ...roles.map(r => el('div', { class: 'list-row' },
        el('span', { class: 'role-dot', style: `background:${r.color || '#888'}` }),
        el('span', { class: 'grow' }, roleLabel(r), r.is_system ? ' (System)' : ''),
        el('button', { class: 'btn ghost small', onclick: () => renderEdit(r) }, r.is_system ? 'Ansehen' : 'Bearbeiten'))),
      el('div', { class: 'row end' },
        el('button', { class: 'btn', onclick: () => renderEdit(null) }, '+ Neue Rolle')));
  }

  function renderEdit(role) {
    const ro = !!role?.is_system;
    const name = el('input', { type: 'text', maxlength: 30, value: role ? roleLabel(role) : '', placeholder: 'Rollenname', disabled: ro });
    const color = el('input', { type: 'color', value: role?.color || '#FF2800', disabled: ro });
    const perms = role?.permissions || {};
    const boxes = RIGHTS.map(([key, label]) => {
      const cb = el('input', { type: 'checkbox', disabled: ro });
      cb.checked = !!perms[key];
      return { key, cb, node: el('label', { class: 'switch-row' }, cb, el('span', {}, label)) };
    });
    const actions = [el('button', { class: 'btn ghost', onclick: load }, 'Zurück')];
    if (!ro) {
      actions.push(el('button', { class: 'btn', onclick: async () => {
        const n = name.value.trim();
        if (!n) return toast('Bitte einen Namen eingeben.');
        const p = Object.fromEntries(boxes.map(b => [b.key, b.cb.checked]));
        try {
          if (role) await call('update_role', { p_role_id: role.id, p_name: n, p_color: color.value, p_permissions: p });
          else await call('create_role', { p_chat_id: chatId, p_name: n, p_color: color.value, p_permissions: p });
          toast('Gespeichert.'); load();
        } catch (e) { toast(e.message); }
      } }, 'Speichern'));
      if (role) actions.unshift(el('button', { class: 'btn danger', onclick: async () => {
        if (!await confirmDialog('Rolle löschen? Mitglieder fallen auf „Mitglied“ zurück.', 'Löschen')) return;
        try { await call('delete_role', { p_role_id: role.id }); toast('Rolle gelöscht.'); load(); } catch (e) { toast(e.message); }
      } }, 'Löschen'));
    }
    body.replaceChildren(
      ro ? el('p', { class: 'muted' }, 'Systemrollen können nicht geändert werden.') : null,
      el('label', { class: 'field' }, 'Name', name),
      el('label', { class: 'field' }, 'Farbe', color),
      el('div', { class: 'switch-list' }, boxes.map(b => b.node)),
      el('div', { class: 'row end' }, actions));
  }

  load();
  return m;
}
