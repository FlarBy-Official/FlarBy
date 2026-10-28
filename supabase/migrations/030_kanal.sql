-- 030: Ansage-Kanal "FlarChat Updates" (wie ein WhatsApp-Kanal). Idempotent.
-- Alle sind automatisch Mitglied, niemand kann gehen oder stumm schalten.
-- Schreiben dürfen nur Admins und der Owner. Reagieren nur bei Nachrichten, die mit /React enden.

-- ---------- Chat-Typ 'channel' erlauben, nur ein Kanal ----------
alter table public.chats drop constraint if exists chats_type_check;
alter table public.chats add constraint chats_type_check check (type in ('direct', 'group', 'ticket', 'channel'));
create unique index if not exists chats_one_channel on public.chats ((type)) where type = 'channel';

-- ---------- Rechte: im Kanal nur Admins und Owner ----------
create or replace function public.has_chat_perm(p_chat uuid, p_user uuid, p_perm text)
returns boolean language plpgsql stable security definer set search_path = public, extensions as $$
declare
  v_type text;
  v_role public.chat_roles;
begin
  select type into v_type from public.chats where id = p_chat;
  if v_type is null or not public.is_chat_member(p_chat, p_user) then
    return false;
  end if;
  if v_type = 'channel' then
    return p_perm in ('send_messages', 'send_media', 'delete_others_messages', 'pin_messages')
      and exists (select 1 from public.profiles where id = p_user and global_role in ('admin', 'owner'));
  end if;
  if v_type = 'direct' then
    return p_perm in ('send_messages', 'send_media');
  end if;
  if v_type = 'ticket' then
    return p_perm in ('send_messages', 'send_media')
      and exists (select 1 from public.chats where id = p_chat and closed_at is null);
  end if;
  select r.* into v_role from public.chat_members m
    join public.chat_roles r on r.id = m.role_id
   where m.chat_id = p_chat and m.user_id = p_user;
  if not found then
    return false;
  end if;
  if v_role.system_key = 'owner' then
    return true;
  end if;
  return coalesce((v_role.permissions ->> p_perm)::boolean, false);
end;
$$;

-- ---------- Reagieren: Admins/Owner immer, alle anderen nur bei /React am Ende ----------
create or replace function public.react_message(p_message_id uuid, p_emoji text)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._me();
  v_chat uuid;
  v_body text;
  v_old text;
begin
  select chat_id, body into v_chat, v_body from public.messages where id = p_message_id and deleted_at is null;
  if v_chat is null or not public.is_chat_member(v_chat, v_uid) then
    raise exception 'Nachricht nicht gefunden.';
  end if;
  select emoji into v_old from public.message_reactions where message_id = p_message_id and user_id = v_uid;
  if p_emoji is null or p_emoji = v_old then
    delete from public.message_reactions where message_id = p_message_id and user_id = v_uid;
    return;
  end if;
  if exists (select 1 from public.chats where id = v_chat and type = 'channel')
     and not exists (select 1 from public.profiles where id = v_uid and global_role in ('admin', 'owner'))
     and coalesce(v_body, '') !~* '/react\s*$' then
    raise exception 'Auf diese Nachricht kann man nicht reagieren.';
  end if;
  if not public.rls_can_send(v_chat, false)
     and not exists (select 1 from public.chats where id = v_chat and type = 'channel') then
    raise exception 'Du darfst gerade nicht reagieren.';
  end if;
  insert into public.message_reactions(message_id, chat_id, user_id, emoji)
    values (p_message_id, v_chat, v_uid, p_emoji)
    on conflict (message_id, user_id) do update set emoji = excluded.emoji, created_at = now();
end;
$$;

-- ---------- Verlassen verboten ----------
create or replace function public.leave_chat(p_chat_id uuid)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._me();
  v_key text;
begin
  if not public.is_chat_member(p_chat_id, v_uid) then
    raise exception 'Du bist kein Mitglied dieses Chats.';
  end if;
  if exists (select 1 from public.chats where id = p_chat_id and type = 'ticket') then
    raise exception 'Ein Ticket kann man nicht verlassen. Ist es geschlossen, kannst du es löschen.';
  end if;
  if exists (select 1 from public.chats where id = p_chat_id and type = 'channel') then
    raise exception 'Den Kanal kann man nicht verlassen.';
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

-- ---------- Stumm schalten verboten (Server) ----------
create or replace function public._no_mute_channel()
returns trigger language plpgsql security definer set search_path = public, extensions as $$
begin
  if exists (select 1 from public.chats where id = new.chat_id and type = 'channel') then
    return null;
  end if;
  return new;
end;
$$;
drop trigger if exists push_muted_no_channel on public.push_muted_chats;
create trigger push_muted_no_channel before insert on public.push_muted_chats
  for each row execute function public._no_mute_channel();

-- ---------- Kanal anlegen, alle hinzufügen ----------
insert into public.chats (type, name, avatar_url, verified, created_by)
select 'channel', 'FlarChat Updates', 'emoji:📢|#1A73E8', true,
       (select id from public.profiles where global_role = 'owner' order by created_at limit 1)
where not exists (select 1 from public.chats where type = 'channel');

insert into public.chat_members (chat_id, user_id)
select c.id, p.id from public.chats c cross join public.profiles p
where c.type = 'channel'
on conflict do nothing;

delete from public.push_muted_chats where chat_id in (select id from public.chats where type = 'channel');

-- ---------- Neue Nutzer kommen automatisch in den Kanal ----------
create or replace function public._join_channel()
returns trigger language plpgsql security definer set search_path = public, extensions as $$
begin
  insert into public.chat_members (chat_id, user_id)
  select id, new.id from public.chats where type = 'channel'
  on conflict do nothing;
  return new;
end;
$$;
drop trigger if exists profiles_join_channel on public.profiles;
create trigger profiles_join_channel after insert on public.profiles
  for each row execute function public._join_channel();
