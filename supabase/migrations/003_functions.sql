-- FlarChat 003: RPC-Funktionen (security definer, serverseitige Rechteprüfung)

-- ============ interne Helper ============
create or replace function public._me()
returns uuid language plpgsql stable security definer set search_path = public, extensions as $$
declare
  v_uid uuid := auth.uid();
  v_banned boolean;
begin
  if v_uid is null then
    raise exception 'Nicht angemeldet.';
  end if;
  select banned into v_banned from public.profiles where id = v_uid;
  if v_banned is null then
    raise exception 'Profil nicht gefunden.';
  end if;
  if v_banned then
    raise exception 'Dein Konto ist gesperrt.';
  end if;
  return v_uid;
end;
$$;

create or replace function public._audit(p_action text, p_target text, p_details jsonb default '{}'::jsonb)
returns void language sql security definer set search_path = public, extensions as $$
  insert into public.audit_log(actor_id, action, target, details) values (auth.uid(), p_action, p_target, coalesce(p_details, '{}'::jsonb));
$$;

create or replace function public._need_rank(p_min int, p_msg text default 'Dazu fehlt dir die Berechtigung.')
returns uuid language plpgsql stable security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._me();
begin
  if public.global_rank(v_uid) < p_min then
    raise exception '%', p_msg;
  end if;
  return v_uid;
end;
$$;

-- Prüft Chat-Recht (Gruppe) und gibt Nutzer-ID zurück
create or replace function public._need_chat_perm(p_chat uuid, p_perm text, p_msg text default 'Dazu fehlt dir die Berechtigung in diesem Chat.')
returns uuid language plpgsql stable security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._me();
begin
  if not exists (select 1 from public.chats where id = p_chat) then
    raise exception 'Chat nicht gefunden.';
  end if;
  if not public.is_chat_member(p_chat, v_uid) then
    raise exception 'Du bist kein Mitglied dieses Chats.';
  end if;
  if not public.has_chat_perm(p_chat, v_uid, p_perm) then
    raise exception '%', p_msg;
  end if;
  return v_uid;
end;
$$;

create or replace function public._is_group(p_chat uuid)
returns boolean language sql stable security definer set search_path = public, extensions as $$
  select exists (select 1 from public.chats where id = p_chat and type = 'group');
$$;

-- 12 Ziffern, kryptografisch zufällig, ohne Modulo-Verzerrung (Bytes >= 250 werden verworfen)
create or replace function public._gen_code_digits()
returns text language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  v_out text := '';
  v_bytes bytea;
  v_i int;
  v_b int;
begin
  while char_length(v_out) < 12 loop
    v_bytes := gen_random_bytes(32);
    for v_i in 0..31 loop
      v_b := get_byte(v_bytes, v_i);
      if v_b < 250 then
        v_out := v_out || (v_b % 10)::text;
        exit when char_length(v_out) = 12;
      end if;
    end loop;
  end loop;
  return v_out;
end;
$$;

create or replace function public._fmt_code(p_code text)
returns text language sql immutable set search_path = public, extensions as $$
  select substr(p_code, 1, 4) || '-' || substr(p_code, 5, 4) || '-' || substr(p_code, 9, 4);
$$;

create or replace function public._new_code(p_kind text, p_chat uuid, p_hours int)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare
  v_code text;
  v_hours int := coalesce(p_hours, 24);
begin
  if v_hours < 1 or v_hours > 720 then
    raise exception 'Gültigkeit muss zwischen 1 und 720 Stunden liegen.';
  end if;
  loop
    v_code := public._gen_code_digits();
    begin
      insert into public.invite_codes(code, kind, chat_id, created_by, expires_at)
        values (v_code, p_kind, p_chat, auth.uid(), now() + make_interval(hours => v_hours));
      exit;
    exception when unique_violation then
      null;
    end;
  end loop;
  return public._fmt_code(v_code);
end;
$$;

-- Rechte-JSON prüfen: nur Schlüssel [a-z_] mit bool-Werten
create or replace function public._clean_perms(p_perms jsonb)
returns jsonb language plpgsql immutable set search_path = public, extensions as $$
declare
  v_out jsonb := '{}'::jsonb;
  r record;
begin
  if p_perms is null or jsonb_typeof(p_perms) <> 'object' then
    raise exception 'Ungültige Rechte.';
  end if;
  for r in select key, value from jsonb_each(p_perms) loop
    if r.key !~ '^[a-z_]{1,40}$' or jsonb_typeof(r.value) <> 'boolean' then
      raise exception 'Ungültige Rechte.';
    end if;
    v_out := v_out || jsonb_build_object(r.key, r.value);
  end loop;
  return v_out;
end;
$$;

-- Nachricht weich löschen; Original bleibt nur im Admin-Bereich erhalten
create or replace function public._soft_delete(p_msg uuid, p_actor uuid)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_m public.messages;
begin
  select * into v_m from public.messages where id = p_msg for update;
  if not found or v_m.deleted_at is not null then
    return;
  end if;
  insert into public.deleted_message_content(message_id, body, media_path)
    values (v_m.id, v_m.body, v_m.media_path) on conflict (message_id) do nothing;
  update public.messages set deleted_at = now(), deleted_by = p_actor, body = '', media_path = null where id = p_msg;
  update public.chats set pinned_message_id = null where id = v_m.chat_id and pinned_message_id = p_msg;
end;
$$;

-- ============ Chats / Nutzer ============
create or replace function public.create_group(p_name text)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._me();
  v_name text := btrim(coalesce(p_name, ''));
  v_chat uuid;
  v_owner_role uuid;
  v_all jsonb := jsonb_build_object(
    'send_messages', true, 'send_media', true, 'delete_others_messages', true, 'invite_members', true,
    'remove_members', true, 'assign_roles', true, 'edit_chat_info', true, 'pin_messages', true,
    'delete_chat', true, 'transfer_ownership', true, 'manage_roles', true);
begin
  if char_length(v_name) < 1 or char_length(v_name) > 50 then
    raise exception 'Der Gruppenname muss 1 bis 50 Zeichen lang sein.';
  end if;
  if coalesce((select (value)::text = 'true' from public.app_settings where key = 'group_creation_restricted'), false)
     and public.global_rank(v_uid) < 2 then
    raise exception 'Gruppen dürfen aktuell nur vom Team erstellt werden.';
  end if;
  insert into public.chats(type, name, created_by) values ('group', v_name, v_uid) returning id into v_chat;
  insert into public.chat_roles(chat_id, name, color, is_system, system_key, permissions, position)
    values (v_chat, 'Besitzer', '#FF2800', true, 'owner', v_all, 0) returning id into v_owner_role;
  insert into public.chat_roles(chat_id, name, color, is_system, system_key, permissions, position)
    values (v_chat, 'Admin', '#D40000', true, 'admin', v_all - 'delete_chat' - 'transfer_ownership', 1),
           (v_chat, 'Mitglied', '#8696A0', true, 'member', '{"send_messages": true, "send_media": true}'::jsonb, 2);
  insert into public.chat_members(chat_id, user_id, role_id) values (v_chat, v_uid, v_owner_role);
  return v_chat;
end;
$$;

create or replace function public.start_direct(p_user_id uuid)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._me();
  v_chat uuid;
begin
  if p_user_id is null or p_user_id = v_uid then
    raise exception 'Ungültiger Nutzer.';
  end if;
  if not exists (select 1 from public.profiles where id = p_user_id and not banned) then
    raise exception 'Nutzer nicht gefunden.';
  end if;
  select c.id into v_chat from public.chats c
    where c.type = 'direct'
      and exists (select 1 from public.chat_members a where a.chat_id = c.id and a.user_id = v_uid)
      and exists (select 1 from public.chat_members b where b.chat_id = c.id and b.user_id = p_user_id)
    limit 1;
  if v_chat is null then
    insert into public.chats(type, created_by) values ('direct', v_uid) returning id into v_chat;
    insert into public.chat_members(chat_id, user_id) values (v_chat, v_uid), (v_chat, p_user_id);
  end if;
  return v_chat;
end;
$$;

create or replace function public.find_users(p_query text)
returns setof public.profiles_public language plpgsql stable security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._me();
  v_q text := lower(btrim(coalesce(p_query, '')));
begin
  if char_length(v_q) < 2 then
    raise exception 'Bitte mindestens 2 Zeichen eingeben.';
  end if;
  v_q := replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_');
  return query
    select pp.* from public.profiles_public pp
    join public.profiles p on p.id = pp.id
    where p.id <> v_uid and not p.banned
      and (p.username like v_q || '%' or lower(p.display_name) like '%' || v_q || '%')
    order by (p.username = v_q) desc, p.username
    limit 20;
end;
$$;

create or replace function public.leave_chat(p_chat_id uuid)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._me();
  v_key text;
begin
  if not public.is_chat_member(p_chat_id, v_uid) then
    raise exception 'Du bist kein Mitglied dieses Chats.';
  end if;
  select r.system_key into v_key from public.chat_members m
    left join public.chat_roles r on r.id = m.role_id
    where m.chat_id = p_chat_id and m.user_id = v_uid;
  if v_key = 'owner' then
    raise exception 'Als Besitzer musst du zuerst die Besitzerrolle übertragen oder den Chat löschen.';
  end if;
  delete from public.chat_members where chat_id = p_chat_id and user_id = v_uid;
end;
$$;

create or replace function public.delete_chat(p_chat_id uuid)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._need_chat_perm(p_chat_id, 'delete_chat', 'Nur der Besitzer darf den Chat löschen.');
  v_name text;
begin
  if not public._is_group(p_chat_id) then
    raise exception 'Nur Gruppen können gelöscht werden.';
  end if;
  select name into v_name from public.chats where id = p_chat_id;
  perform public._audit('chat_delete', p_chat_id::text, jsonb_build_object('name', v_name));
  delete from public.chats where id = p_chat_id;
end;
$$;

create or replace function public.mark_read(p_chat_id uuid)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._me();
begin
  update public.chat_members set last_read_at = now() where chat_id = p_chat_id and user_id = v_uid;
end;
$$;

create or replace function public.touch_presence()
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._me();
begin
  update public.profiles set last_seen = now() where id = v_uid;
end;
$$;

-- ============ Gruppe ============
create or replace function public.update_chat(p_chat_id uuid, p_name text, p_avatar_url text)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._need_chat_perm(p_chat_id, 'edit_chat_info');
  v_name text := btrim(coalesce(p_name, ''));
begin
  if not public._is_group(p_chat_id) then
    raise exception 'Nur Gruppen können bearbeitet werden.';
  end if;
  if char_length(v_name) < 1 or char_length(v_name) > 50 then
    raise exception 'Der Gruppenname muss 1 bis 50 Zeichen lang sein.';
  end if;
  update public.chats set name = v_name, avatar_url = nullif(btrim(coalesce(p_avatar_url, '')), '') where id = p_chat_id;
end;
$$;

create or replace function public.remove_member(p_chat_id uuid, p_user_id uuid)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._need_chat_perm(p_chat_id, 'remove_members');
  v_key text;
begin
  if not public._is_group(p_chat_id) then
    raise exception 'Nur in Gruppen können Mitglieder entfernt werden.';
  end if;
  if p_user_id = v_uid then
    raise exception 'Zum Verlassen nutze „Chat verlassen“.';
  end if;
  select r.system_key into v_key from public.chat_members m
    left join public.chat_roles r on r.id = m.role_id
    where m.chat_id = p_chat_id and m.user_id = p_user_id;
  if not found then
    raise exception 'Nutzer ist kein Mitglied.';
  end if;
  if v_key = 'owner' then
    raise exception 'Der Besitzer kann nicht entfernt werden.';
  end if;
  if v_key = 'admin' and not public.has_chat_perm(p_chat_id, v_uid, 'transfer_ownership') then
    raise exception 'Admins kann nur der Besitzer entfernen.';
  end if;
  delete from public.chat_members where chat_id = p_chat_id and user_id = p_user_id;
end;
$$;

create or replace function public.set_member_role(p_chat_id uuid, p_user_id uuid, p_role_id uuid)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._need_chat_perm(p_chat_id, 'assign_roles');
  v_cur text;
  v_new public.chat_roles;
  v_is_owner boolean;
begin
  if not public._is_group(p_chat_id) then
    raise exception 'Rollen gibt es nur in Gruppen.';
  end if;
  select * into v_new from public.chat_roles where id = p_role_id and chat_id = p_chat_id;
  if not found then
    raise exception 'Rolle nicht gefunden.';
  end if;
  if v_new.system_key = 'owner' then
    raise exception 'Die Besitzerrolle kann nur per Eigentumsübertragung vergeben werden.';
  end if;
  select r.system_key into v_cur from public.chat_members m
    left join public.chat_roles r on r.id = m.role_id
    where m.chat_id = p_chat_id and m.user_id = p_user_id;
  if not found then
    raise exception 'Nutzer ist kein Mitglied.';
  end if;
  if v_cur = 'owner' then
    raise exception 'Die Rolle des Besitzers kann nicht geändert werden.';
  end if;
  v_is_owner := public.has_chat_perm(p_chat_id, v_uid, 'transfer_ownership');
  if not v_is_owner and (v_cur = 'admin' or v_new.system_key = 'admin') then
    raise exception 'Die Admin-Rolle kann nur der Besitzer vergeben oder ändern.';
  end if;
  if not v_is_owner and exists (
      select 1 from jsonb_each(v_new.permissions) e
      where e.value = 'true'::jsonb and not public.has_chat_perm(p_chat_id, v_uid, e.key)) then
    raise exception 'Du kannst keine Rolle mit Rechten vergeben, die du selbst nicht hast.';
  end if;
  update public.chat_members set role_id = p_role_id where chat_id = p_chat_id and user_id = p_user_id;
end;
$$;

create or replace function public.create_role(p_chat_id uuid, p_name text, p_color text, p_permissions jsonb)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._need_chat_perm(p_chat_id, 'manage_roles');
  v_name text := btrim(coalesce(p_name, ''));
  v_perms jsonb := public._clean_perms(p_permissions);
  v_id uuid;
  v_pos int;
begin
  if not public._is_group(p_chat_id) then
    raise exception 'Rollen gibt es nur in Gruppen.';
  end if;
  if char_length(v_name) < 1 or char_length(v_name) > 30 then
    raise exception 'Der Rollenname muss 1 bis 30 Zeichen lang sein.';
  end if;
  if p_color is not null and p_color !~ '^#[0-9A-Fa-f]{6}$' then
    raise exception 'Ungültige Farbe.';
  end if;
  if exists (select 1 from jsonb_each(v_perms) e
             where e.value = 'true'::jsonb and not public.has_chat_perm(p_chat_id, v_uid, e.key)) then
    raise exception 'Du kannst keine Rechte vergeben, die du selbst nicht hast.';
  end if;
  select coalesce(max(position), 2) + 1 into v_pos from public.chat_roles where chat_id = p_chat_id;
  insert into public.chat_roles(chat_id, name, color, is_system, permissions, position)
    values (p_chat_id, v_name, p_color, false, v_perms, v_pos) returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.update_role(p_role_id uuid, p_name text, p_color text, p_permissions jsonb)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_role public.chat_roles;
  v_uid uuid;
  v_name text := btrim(coalesce(p_name, ''));
  v_perms jsonb := public._clean_perms(p_permissions);
begin
  select * into v_role from public.chat_roles where id = p_role_id;
  if not found then
    raise exception 'Rolle nicht gefunden.';
  end if;
  v_uid := public._need_chat_perm(v_role.chat_id, 'manage_roles');
  if v_role.system_key = 'owner' then
    raise exception 'Die Besitzerrolle kann nicht geändert werden.';
  end if;
  if v_role.is_system then
    if v_name <> v_role.name then
      raise exception 'Systemrollen können nicht umbenannt werden.';
    end if;
    if v_role.system_key = 'admin' then
      v_perms := v_perms - 'delete_chat' - 'transfer_ownership';
    end if;
  end if;
  if char_length(v_name) < 1 or char_length(v_name) > 30 then
    raise exception 'Der Rollenname muss 1 bis 30 Zeichen lang sein.';
  end if;
  if p_color is not null and p_color !~ '^#[0-9A-Fa-f]{6}$' then
    raise exception 'Ungültige Farbe.';
  end if;
  if not public.has_chat_perm(v_role.chat_id, v_uid, 'transfer_ownership') then
    if v_role.system_key = 'admin' then
      raise exception 'Die Admin-Rolle kann nur der Besitzer ändern.';
    end if;
    if exists (select 1 from jsonb_each(v_perms) e
               where e.value = 'true'::jsonb and not public.has_chat_perm(v_role.chat_id, v_uid, e.key)) then
      raise exception 'Du kannst keine Rechte vergeben, die du selbst nicht hast.';
    end if;
  end if;
  update public.chat_roles set name = v_name, color = p_color, permissions = v_perms where id = p_role_id;
end;
$$;

create or replace function public.delete_role(p_role_id uuid)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_role public.chat_roles;
  v_member uuid;
begin
  select * into v_role from public.chat_roles where id = p_role_id;
  if not found then
    raise exception 'Rolle nicht gefunden.';
  end if;
  perform public._need_chat_perm(v_role.chat_id, 'manage_roles');
  if v_role.is_system then
    raise exception 'Systemrollen können nicht gelöscht werden.';
  end if;
  select id into v_member from public.chat_roles where chat_id = v_role.chat_id and system_key = 'member';
  update public.chat_members set role_id = v_member where chat_id = v_role.chat_id and role_id = p_role_id;
  delete from public.chat_roles where id = p_role_id;
end;
$$;

create or replace function public.transfer_ownership(p_chat_id uuid, p_user_id uuid)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._need_chat_perm(p_chat_id, 'transfer_ownership', 'Nur der Besitzer darf die Besitzerrolle übertragen.');
  v_owner uuid;
  v_admin uuid;
begin
  if not public._is_group(p_chat_id) then
    raise exception 'Nur in Gruppen möglich.';
  end if;
  if p_user_id = v_uid then
    raise exception 'Du bist bereits Besitzer.';
  end if;
  if not public.is_chat_member(p_chat_id, p_user_id) then
    raise exception 'Nutzer ist kein Mitglied.';
  end if;
  select id into v_owner from public.chat_roles where chat_id = p_chat_id and system_key = 'owner';
  select id into v_admin from public.chat_roles where chat_id = p_chat_id and system_key = 'admin';
  update public.chat_members set role_id = v_owner where chat_id = p_chat_id and user_id = p_user_id;
  update public.chat_members set role_id = v_admin where chat_id = p_chat_id and user_id = v_uid;
  perform public._audit('chat_transfer_ownership', p_chat_id::text, jsonb_build_object('to', p_user_id));
end;
$$;

create or replace function public.pin_message(p_chat_id uuid, p_message_id uuid)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._need_chat_perm(p_chat_id, 'pin_messages');
begin
  if not public._is_group(p_chat_id) then
    raise exception 'Anheften ist nur in Gruppen möglich.';
  end if;
  if p_message_id is not null and not exists (
      select 1 from public.messages where id = p_message_id and chat_id = p_chat_id and deleted_at is null) then
    raise exception 'Nachricht nicht gefunden.';
  end if;
  update public.chats set pinned_message_id = p_message_id where id = p_chat_id;
end;
$$;

-- ============ Nachrichten ============
create or replace function public.edit_message(p_message_id uuid, p_body text)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._me();
  v_m public.messages;
  v_body text := btrim(coalesce(p_body, ''));
begin
  select * into v_m from public.messages where id = p_message_id for update;
  if not found or v_m.sender_id <> v_uid then
    raise exception 'Du kannst nur eigene Nachrichten bearbeiten.';
  end if;
  if v_m.deleted_at is not null then
    raise exception 'Gelöschte Nachrichten können nicht bearbeitet werden.';
  end if;
  if v_m.created_at < now() - interval '3 days' then
    raise exception 'Nachrichten können nur 3 Tage lang bearbeitet werden.';
  end if;
  if not public.has_chat_perm(v_m.chat_id, v_uid, 'send_messages') then
    raise exception 'Du darfst in diesem Chat nicht schreiben.';
  end if;
  if exists (select 1 from public.profiles where id = v_uid and muted_until > now()) then
    raise exception 'Du bist stummgeschaltet.';
  end if;
  if char_length(v_body) > 4000 or (v_body = '' and v_m.media_path is null) then
    raise exception 'Ungültiger Nachrichtentext.';
  end if;
  insert into public.message_edits(message_id, old_body) values (v_m.id, v_m.body);
  update public.messages set body = v_body, edited_at = now() where id = v_m.id;
end;
$$;

create or replace function public.delete_message(p_message_id uuid)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._me();
  v_m public.messages;
begin
  select * into v_m from public.messages where id = p_message_id;
  if not found or not public.is_chat_member(v_m.chat_id, v_uid) then
    raise exception 'Nachricht nicht gefunden.';
  end if;
  if v_m.sender_id <> v_uid and not public.has_chat_perm(v_m.chat_id, v_uid, 'delete_others_messages') then
    raise exception 'Du darfst diese Nachricht nicht löschen.';
  end if;
  perform public._soft_delete(p_message_id, v_uid);
end;
$$;

-- ============ Codes ============
create or replace function public.create_chat_code(p_chat_id uuid, p_hours int default 24)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._need_chat_perm(p_chat_id, 'invite_members', 'Du darfst keine Mitglieder einladen.');
begin
  if not public._is_group(p_chat_id) then
    raise exception 'Einladungscodes gibt es nur für Gruppen.';
  end if;
  return public._new_code('chat', p_chat_id, p_hours);
end;
$$;

create or replace function public.create_register_code(p_hours int default 24)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._need_rank(2, 'Nur Admins dürfen Registrier-Codes erzeugen.');
  v_code text;
begin
  v_code := public._new_code('register', null, p_hours);
  perform public._audit('register_code_create', null, '{}'::jsonb);
  return v_code;
end;
$$;

create or replace function public.redeem_chat_code(p_code text)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._me();
  v_digits text := regexp_replace(coalesce(p_code, ''), '[^0-9]', '', 'g');
  v_c public.invite_codes;
  v_member uuid;
begin
  if char_length(v_digits) <> 12 then
    raise exception 'Ungültiger Code.';
  end if;
  select * into v_c from public.invite_codes where code = v_digits for update;
  if not found or v_c.kind <> 'chat' or v_c.used_at is not null or v_c.used_by is not null
     or v_c.revoked or v_c.expires_at <= now() then
    raise exception 'Der Code ist ungültig, abgelaufen oder wurde bereits verwendet.';
  end if;
  if not exists (select 1 from public.chats where id = v_c.chat_id) then
    raise exception 'Der Code ist ungültig, abgelaufen oder wurde bereits verwendet.';
  end if;
  if public.is_chat_member(v_c.chat_id, v_uid) then
    raise exception 'Du bist bereits Mitglied dieses Chats.';
  end if;
  select id into v_member from public.chat_roles where chat_id = v_c.chat_id and system_key = 'member';
  insert into public.chat_members(chat_id, user_id, role_id) values (v_c.chat_id, v_uid, v_member);
  update public.invite_codes set used_by = v_uid, used_at = now() where id = v_c.id;
  return v_c.chat_id;
end;
$$;

-- Berechtigung für Verwaltung eines Codes prüfen
create or replace function public._need_code_admin(p_code public.invite_codes)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._me();
begin
  if p_code.kind = 'register' then
    if public.global_rank(v_uid) < 2 then
      raise exception 'Nur Admins dürfen Registrier-Codes verwalten.';
    end if;
  elsif not public.has_chat_perm(p_code.chat_id, v_uid, 'invite_members') then
    raise exception 'Du darfst Einladungen in diesem Chat nicht verwalten.';
  end if;
end;
$$;

create or replace function public.revoke_code(p_code_id uuid)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_c public.invite_codes;
begin
  select * into v_c from public.invite_codes where id = p_code_id for update;
  if not found then
    raise exception 'Code nicht gefunden.';
  end if;
  perform public._need_code_admin(v_c);
  if v_c.used_at is not null then
    raise exception 'Der Code wurde bereits verwendet.';
  end if;
  update public.invite_codes set revoked = true where id = p_code_id;
  if v_c.kind = 'register' then
    perform public._audit('register_code_revoke', p_code_id::text, '{}'::jsonb);
  end if;
end;
$$;

create or replace function public.list_codes(p_chat_id uuid default null)
returns table (id uuid, code text, kind text, chat_id uuid, created_by uuid, created_at timestamptz,
               expires_at timestamptz, used_by uuid, used_at timestamptz, revoked boolean, status text)
language plpgsql stable security definer set search_path = public, extensions as $$
#variable_conflict use_column
declare
  v_uid uuid := public._me();
begin
  if p_chat_id is null then
    if public.global_rank(v_uid) < 2 then
      raise exception 'Nur Admins dürfen Registrier-Codes sehen.';
    end if;
  elsif not public.has_chat_perm(p_chat_id, v_uid, 'invite_members') then
    raise exception 'Du darfst Einladungen in diesem Chat nicht sehen.';
  end if;
  return query
    select ic.id, public._fmt_code(ic.code), ic.kind, ic.chat_id, ic.created_by, ic.created_at, ic.expires_at,
           ic.used_by, ic.used_at, ic.revoked,
           case when ic.used_at is not null then 'used'
                when ic.revoked then 'revoked'
                when ic.expires_at <= now() then 'expired'
                else 'active' end
    from public.invite_codes ic
    where (p_chat_id is null and ic.kind = 'register') or (p_chat_id is not null and ic.chat_id = p_chat_id)
    order by ic.created_at desc
    limit 200;
end;
$$;

create or replace function public.reactivate_code(p_code_id uuid)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare
  v_c public.invite_codes;
  v_new text;
begin
  select * into v_c from public.invite_codes where id = p_code_id for update;
  if not found then
    raise exception 'Code nicht gefunden.';
  end if;
  perform public._need_code_admin(v_c);
  if v_c.kind = 'chat' and not public._is_group(v_c.chat_id) then
    raise exception 'Chat nicht gefunden.';
  end if;
  update public.invite_codes set revoked = true where id = p_code_id and used_at is null;
  v_new := public._new_code(v_c.kind, v_c.chat_id, 24);
  if v_c.kind = 'register' then
    perform public._audit('register_code_reactivate', p_code_id::text, '{}'::jsonb);
  end if;
  return v_new;
end;
$$;

-- ============ Moderation ============
create or replace function public.report_message(p_message_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._me();
  v_m public.messages;
  v_reason text := btrim(coalesce(p_reason, ''));
begin
  select * into v_m from public.messages where id = p_message_id;
  if not found or not public.is_chat_member(v_m.chat_id, v_uid) then
    raise exception 'Nachricht nicht gefunden.';
  end if;
  if v_m.sender_id = v_uid then
    raise exception 'Du kannst deine eigenen Nachrichten nicht melden.';
  end if;
  if char_length(v_reason) < 1 or char_length(v_reason) > 500 then
    raise exception 'Bitte gib einen Grund (max. 500 Zeichen) an.';
  end if;
  if exists (select 1 from public.reports where message_id = p_message_id and reporter_id = v_uid and status = 'open') then
    raise exception 'Du hast diese Nachricht bereits gemeldet.';
  end if;
  insert into public.reports(message_id, chat_id, reporter_id, reason) values (p_message_id, v_m.chat_id, v_uid, v_reason);
end;
$$;

create or replace function public.list_reports()
returns table (id uuid, message_id uuid, chat_id uuid, reporter_id uuid, reporter_username text, reason text,
               status text, handled_by uuid, created_at timestamptz, message_body text, message_sender_id uuid,
               message_sender_username text, message_deleted boolean)
language plpgsql stable security definer set search_path = public, extensions as $$
#variable_conflict use_column
declare
  v_uid uuid := public._need_rank(1, 'Nur das Team darf Meldungen sehen.');
begin
  return query
    select r.id, r.message_id, r.chat_id, r.reporter_id, rp.username, r.reason, r.status, r.handled_by, r.created_at,
           case when m.deleted_at is null then m.body else coalesce(d.body, '') end,
           m.sender_id, sp.username, (m.deleted_at is not null)
    from public.reports r
    join public.messages m on m.id = r.message_id
    left join public.deleted_message_content d on d.message_id = m.id
    left join public.profiles rp on rp.id = r.reporter_id
    left join public.profiles sp on sp.id = m.sender_id
    order by (r.status = 'open') desc, r.created_at desc
    limit 300;
end;
$$;

create or replace function public.report_context(p_report_id uuid)
returns setof public.messages language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._need_rank(1, 'Nur das Team darf Meldungen bearbeiten.');
  v_r public.reports;
  v_m public.messages;
begin
  select * into v_r from public.reports where id = p_report_id;
  if not found then
    raise exception 'Meldung nicht gefunden.';
  end if;
  select * into v_m from public.messages where id = v_r.message_id;
  perform public._audit('report_context', p_report_id::text, jsonb_build_object('chat_id', v_r.chat_id, 'message_id', v_r.message_id));
  return query
    select x.id, x.chat_id, x.sender_id,
           case when x.deleted_at is not null and x.id = v_m.id then coalesce(d.body, '') else x.body end,
           case when x.deleted_at is not null and x.id = v_m.id then d.media_path else x.media_path end,
           x.reply_to, x.created_at, x.edited_at, x.deleted_at, x.deleted_by
    from (
      (select * from public.messages where chat_id = v_m.chat_id and created_at < v_m.created_at order by created_at desc limit 5)
      union all
      (select * from public.messages where id = v_m.id)
      union all
      (select * from public.messages where chat_id = v_m.chat_id and created_at > v_m.created_at order by created_at asc limit 5)
    ) x
    left join public.deleted_message_content d on d.message_id = x.id
    order by x.created_at;
end;
$$;

create or replace function public.resolve_report(p_report_id uuid)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._need_rank(1, 'Nur das Team darf Meldungen bearbeiten.');
begin
  update public.reports set status = 'resolved', handled_by = v_uid where id = p_report_id;
  if not found then
    raise exception 'Meldung nicht gefunden.';
  end if;
  perform public._audit('report_resolve', p_report_id::text, '{}'::jsonb);
end;
$$;

create or replace function public.mod_delete_message(p_message_id uuid)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._need_rank(1, 'Nur das Team darf Nachrichten moderieren.');
begin
  if not exists (select 1 from public.reports where message_id = p_message_id) then
    raise exception 'Das Team darf nur gemeldete Nachrichten löschen.';
  end if;
  perform public._soft_delete(p_message_id, v_uid);
  perform public._audit('mod_delete_message', p_message_id::text, '{}'::jsonb);
end;
$$;

-- Ziel muss niedrigeren globalen Rang als der Handelnde haben
create or replace function public._check_target(p_actor uuid, p_target uuid)
returns void language plpgsql stable security definer set search_path = public, extensions as $$
begin
  if p_target is null or not exists (select 1 from public.profiles where id = p_target) then
    raise exception 'Nutzer nicht gefunden.';
  end if;
  if p_target = p_actor then
    raise exception 'Das kannst du nicht auf dich selbst anwenden.';
  end if;
  if public.global_rank(p_target) >= public.global_rank(p_actor) then
    raise exception 'Du kannst diese Aktion nicht auf Nutzer mit gleichem oder höherem Rang anwenden.';
  end if;
end;
$$;

create or replace function public.warn_user(p_user_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._need_rank(1, 'Nur das Team darf verwarnen.');
  v_reason text := btrim(coalesce(p_reason, ''));
begin
  perform public._check_target(v_uid, p_user_id);
  if char_length(v_reason) < 1 or char_length(v_reason) > 500 then
    raise exception 'Bitte gib einen Grund (max. 500 Zeichen) an.';
  end if;
  insert into public.warnings(user_id, by_user, reason) values (p_user_id, v_uid, v_reason);
  perform public._audit('warn_user', p_user_id::text, jsonb_build_object('reason', v_reason));
end;
$$;

create or replace function public.mute_user(p_user_id uuid, p_hours int)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._need_rank(1, 'Nur das Team darf stummschalten.');
begin
  perform public._check_target(v_uid, p_user_id);
  if p_hours is null or p_hours < 0 or p_hours > 8760 then
    raise exception 'Ungültige Dauer (0 bis 8760 Stunden, 0 hebt die Stummschaltung auf).';
  end if;
  update public.profiles set muted_until = case when p_hours = 0 then null else now() + make_interval(hours => p_hours) end
    where id = p_user_id;
  perform public._audit('mute_user', p_user_id::text, jsonb_build_object('hours', p_hours));
end;
$$;

create or replace function public.ban_user(p_user_id uuid, p_banned boolean)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._need_rank(2, 'Nur Admins dürfen Nutzer sperren.');
begin
  perform public._check_target(v_uid, p_user_id);
  update public.profiles set banned = coalesce(p_banned, false) where id = p_user_id;
  perform public._audit('ban_user', p_user_id::text, jsonb_build_object('banned', coalesce(p_banned, false)));
end;
$$;

-- ============ Team / Owner ============
create or replace function public.set_global_role(p_user_id uuid, p_role text)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._need_rank(3, 'Nur der Besitzer darf Rollen vergeben.');
begin
  if p_role is null or p_role not in ('user', 'moderator', 'admin', 'owner') then
    raise exception 'Ungültige Rolle.';
  end if;
  if p_user_id = v_uid then
    raise exception 'Du kannst deine eigene Rolle nicht ändern.';
  end if;
  update public.profiles set global_role = p_role where id = p_user_id;
  if not found then
    raise exception 'Nutzer nicht gefunden.';
  end if;
  perform public._audit('set_global_role', p_user_id::text, jsonb_build_object('role', p_role));
end;
$$;

create or replace function public.set_verified(p_kind text, p_id uuid, p_value boolean)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._need_rank(3, 'Nur der Besitzer darf Verifizierungen vergeben.');
begin
  if p_kind = 'user' then
    update public.profiles set verified = coalesce(p_value, false) where id = p_id;
  elsif p_kind = 'chat' then
    update public.chats set verified = coalesce(p_value, false) where id = p_id;
  else
    raise exception 'Ungültige Art (user oder chat).';
  end if;
  if not found then
    raise exception 'Eintrag nicht gefunden.';
  end if;
  perform public._audit('set_verified', p_id::text, jsonb_build_object('kind', p_kind, 'value', coalesce(p_value, false)));
end;
$$;

create or replace function public.set_app_setting(p_key text, p_value jsonb)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._need_rank(3, 'Nur der Besitzer darf Einstellungen ändern.');
begin
  if p_key is null or p_key !~ '^[a-z_]{1,50}$' or p_value is null then
    raise exception 'Ungültige Einstellung.';
  end if;
  insert into public.app_settings(key, value) values (p_key, p_value)
    on conflict (key) do update set value = excluded.value;
  perform public._audit('set_app_setting', p_key, jsonb_build_object('value', p_value));
end;
$$;

create or replace function public.set_my_team_tag_visible(p_value boolean)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._me();
begin
  update public.profiles set team_tag_visible = coalesce(p_value, true) where id = v_uid;
end;
$$;

create or replace function public.set_my_verified_visible(p_value boolean)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._me();
begin
  update public.profiles set verified_visible = coalesce(p_value, true) where id = v_uid;
end;
$$;

create or replace function public.list_users()
returns table (id uuid, username text, display_name text, avatar_url text, global_role text, verified boolean,
               muted_until timestamptz, banned boolean, last_seen timestamptz, created_at timestamptz,
               warnings_count int)
language plpgsql stable security definer set search_path = public, extensions as $$
#variable_conflict use_column
declare
  v_uid uuid := public._need_rank(1, 'Nur das Team darf die Nutzerliste sehen.');
begin
  return query
    select p.id, p.username, p.display_name, p.avatar_url, p.global_role, p.verified, p.muted_until, p.banned,
           p.last_seen, p.created_at, (select count(*)::int from public.warnings w where w.user_id = p.id)
    from public.profiles p
    order by p.created_at;
end;
$$;

create or replace function public.list_tickets()
returns setof public.tickets language plpgsql stable security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._need_rank(2, 'Nur Admins dürfen Tickets sehen.');
begin
  return query select * from public.tickets order by (status = 'open') desc, created_at desc limit 300;
end;
$$;

create or replace function public.close_ticket(p_ticket_id uuid)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._need_rank(2, 'Nur Admins dürfen Tickets bearbeiten.');
begin
  update public.tickets set status = 'done', handled_by = v_uid, handled_at = now() where id = p_ticket_id;
  if not found then
    raise exception 'Ticket nicht gefunden.';
  end if;
  perform public._audit('close_ticket', p_ticket_id::text, '{}'::jsonb);
end;
$$;

create or replace function public.submit_ticket(p_username text, p_message text, p_device_id text)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_user text := lower(btrim(coalesce(p_username, '')));
  v_msg text := btrim(coalesce(p_message, ''));
  v_dev text := btrim(coalesce(p_device_id, ''));
begin
  if char_length(v_user) < 1 or char_length(v_user) > 40 then
    raise exception 'Bitte gib einen Benutzernamen an.';
  end if;
  if char_length(v_msg) < 1 or char_length(v_msg) > 1000 then
    raise exception 'Die Nachricht muss 1 bis 1000 Zeichen lang sein.';
  end if;
  if char_length(v_dev) < 8 or char_length(v_dev) > 100 then
    raise exception 'Ungültige Geräte-ID.';
  end if;
  if (select count(*) from public.tickets where device_id = v_dev and created_at > now() - interval '1 hour') >= 3
     or (select count(*) from public.tickets where username = v_user and created_at > now() - interval '1 hour') >= 3 then
    raise exception 'Zu viele Anfragen. Bitte versuche es in einer Stunde erneut.';
  end if;
  insert into public.tickets(username, message, device_id) values (v_user, v_msg, v_dev);
end;
$$;

create or replace function public.clear_must_change_password()
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._me();
begin
  update public.profiles set must_change_password = false where id = v_uid;
end;
$$;

create or replace function public.my_profile()
returns public.profiles language plpgsql stable security definer set search_path = public, extensions as $$
declare
  v_p public.profiles;
begin
  if auth.uid() is null then
    raise exception 'Nicht angemeldet.';
  end if;
  select * into v_p from public.profiles where id = auth.uid();
  return v_p;
end;
$$;

-- ============ Admin-Lesebereich (nur Owner, PIN) ============
-- Hinweis: Fehlversuche müssen committen, daher kein raise bei falscher PIN (Rückgabe null bzw. false).
create or replace function public.admin_pin_status()
returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._need_rank(3, 'Nur der Besitzer hat Zugriff auf den Admin-Bereich.');
  v_p public.admin_pins;
begin
  select * into v_p from public.admin_pins where user_id = v_uid;
  return jsonb_build_object(
    'has_pin', found,
    'locked_until', case when v_p.locked_until > now() then v_p.locked_until else null end,
    'unlocked_until', case when v_p.unlocked_until > now() then v_p.unlocked_until else null end);
end;
$$;

-- true = PIN gesetzt/geändert, false = alte PIN falsch oder gesperrt
create or replace function public.admin_set_pin(p_old text, p_new text)
returns boolean language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._need_rank(3, 'Nur der Besitzer darf die Admin-PIN setzen.');
  v_p public.admin_pins;
  v_fails int;
begin
  if p_new is null or p_new !~ '^[0-9]{8,12}$' then
    raise exception 'Die PIN muss aus 8 bis 12 Ziffern bestehen.';
  end if;
  select * into v_p from public.admin_pins where user_id = v_uid for update;
  if not found then
    if p_old is not null then
      raise exception 'Es ist noch keine PIN gesetzt.';
    end if;
    insert into public.admin_pins(user_id, pin_hash) values (v_uid, crypt(p_new, gen_salt('bf')));
    perform public._audit('admin_pin_set', null, '{}'::jsonb);
    return true;
  end if;
  if p_old is null then
    raise exception 'Bitte gib die bisherige PIN an.';
  end if;
  if v_p.locked_until is not null and v_p.locked_until > now() then
    return false;
  end if;
  if v_p.pin_hash <> crypt(p_old, v_p.pin_hash) then
    v_fails := v_p.failed_attempts + 1;
    update public.admin_pins set failed_attempts = case when v_fails >= 5 then 0 else v_fails end,
      locked_until = case when v_fails >= 5 then now() + interval '15 minutes' else locked_until end
      where user_id = v_uid;
    perform public._audit('admin_pin_change_failed', null, jsonb_build_object('attempt', v_fails));
    return false;
  end if;
  update public.admin_pins set pin_hash = crypt(p_new, gen_salt('bf')), failed_attempts = 0,
    locked_until = null, unlocked_until = null where user_id = v_uid;
  perform public._audit('admin_pin_changed', null, '{}'::jsonb);
  return true;
end;
$$;

-- Gibt bei Erfolg unlocked_until zurück, bei falscher PIN oder Sperre null
create or replace function public.admin_unlock(p_pin text)
returns timestamptz language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._need_rank(3, 'Nur der Besitzer hat Zugriff auf den Admin-Bereich.');
  v_p public.admin_pins;
  v_fails int;
  v_until timestamptz;
begin
  select * into v_p from public.admin_pins where user_id = v_uid for update;
  if not found then
    raise exception 'Es ist noch keine Admin-PIN gesetzt.';
  end if;
  if v_p.locked_until is not null and v_p.locked_until > now() then
    perform public._audit('admin_unlock_blocked', null, jsonb_build_object('locked_until', v_p.locked_until));
    return null;
  end if;
  if p_pin is null or v_p.pin_hash <> crypt(p_pin, v_p.pin_hash) then
    v_fails := v_p.failed_attempts + 1;
    update public.admin_pins set failed_attempts = case when v_fails >= 5 then 0 else v_fails end,
      locked_until = case when v_fails >= 5 then now() + interval '15 minutes' else null end,
      unlocked_until = null
      where user_id = v_uid;
    perform public._audit('admin_unlock_failed', null, jsonb_build_object('attempt', v_fails, 'locked', v_fails >= 5));
    return null;
  end if;
  v_until := now() + interval '10 minutes';
  update public.admin_pins set failed_attempts = 0, locked_until = null, unlocked_until = v_until where user_id = v_uid;
  perform public._audit('admin_unlock', null, jsonb_build_object('unlocked_until', v_until));
  return v_until;
end;
$$;

create or replace function public._need_admin_unlocked()
returns uuid language plpgsql stable security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._need_rank(3, 'Nur der Besitzer hat Zugriff auf den Admin-Bereich.');
begin
  if not exists (select 1 from public.admin_pins where user_id = v_uid and unlocked_until > now()) then
    raise exception 'Admin-Bereich gesperrt. Bitte PIN eingeben.';
  end if;
  return v_uid;
end;
$$;

create or replace function public.admin_list_chats()
returns table (id uuid, type text, name text, verified boolean, created_at timestamptz, member_count int,
               message_count int, last_message_at timestamptz, members text)
language plpgsql security definer set search_path = public, extensions as $$
#variable_conflict use_column
declare
  v_uid uuid := public._need_admin_unlocked();
begin
  perform public._audit('admin_list_chats', null, '{}'::jsonb);
  return query
    select c.id, c.type, c.name, c.verified, c.created_at,
           (select count(*)::int from public.chat_members m where m.chat_id = c.id),
           (select count(*)::int from public.messages x where x.chat_id = c.id),
           (select max(x.created_at) from public.messages x where x.chat_id = c.id),
           (select string_agg(p.username, ', ' order by p.username) from public.chat_members m
              join public.profiles p on p.id = m.user_id where m.chat_id = c.id)
    from public.chats c
    order by 8 desc nulls last, c.created_at desc;
end;
$$;

create or replace function public.admin_chat_messages(p_chat_id uuid, p_before timestamptz default now(), p_limit int default 100)
returns table (id uuid, chat_id uuid, sender_id uuid, sender_username text, body text, media_path text,
               reply_to uuid, created_at timestamptz, edited_at timestamptz, deleted_at timestamptz,
               deleted_by uuid, edits jsonb)
language plpgsql security definer set search_path = public, extensions as $$
#variable_conflict use_column
declare
  v_uid uuid := public._need_admin_unlocked();
  v_limit int := least(greatest(coalesce(p_limit, 100), 1), 500);
begin
  perform public._audit('admin_read_chat', p_chat_id::text, jsonb_build_object('before', p_before, 'limit', v_limit));
  return query
    select m.id, m.chat_id, m.sender_id, sp.username,
           case when m.deleted_at is not null then coalesce(d.body, '') else m.body end,
           case when m.deleted_at is not null then d.media_path else m.media_path end,
           m.reply_to, m.created_at, m.edited_at, m.deleted_at, m.deleted_by,
           coalesce((select jsonb_agg(jsonb_build_object('old_body', e.old_body, 'edited_at', e.edited_at) order by e.edited_at)
                     from public.message_edits e where e.message_id = m.id), '[]'::jsonb)
    from public.messages m
    left join public.deleted_message_content d on d.message_id = m.id
    left join public.profiles sp on sp.id = m.sender_id
    where m.chat_id = p_chat_id and m.created_at < coalesce(p_before, now())
    order by m.created_at desc
    limit v_limit;
end;
$$;

create or replace function public.admin_audit_log(p_limit int default 200)
returns table (id bigint, actor_id uuid, actor_username text, action text, target text, details jsonb, created_at timestamptz)
language plpgsql security definer set search_path = public, extensions as $$
#variable_conflict use_column
declare
  v_uid uuid := public._need_admin_unlocked();
  v_limit int := least(greatest(coalesce(p_limit, 200), 1), 1000);
begin
  perform public._audit('admin_read_audit', null, jsonb_build_object('limit', v_limit));
  return query
    select a.id, a.actor_id, p.username, a.action, a.target, a.details, a.created_at
    from public.audit_log a left join public.profiles p on p.id = a.actor_id
    order by a.id desc
    limit v_limit;
end;
$$;
