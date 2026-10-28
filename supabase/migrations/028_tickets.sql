-- 028: Support-Tickets per /ticket. Jedes Ticket ist ein eigener Chat (type = 'ticket') mit dem Nutzer
-- und allen Teamlern. Idempotent.

-- ---------- Chat-Typ 'ticket' erlauben, längere Namen ----------
do $$
declare
  r record;
begin
  for r in select conname from pg_constraint
           where conrelid = 'public.chats'::regclass and contype = 'c'
             and (pg_get_constraintdef(oid) like '%direct%' or pg_get_constraintdef(oid) like '%char_length(name)%') loop
    execute format('alter table public.chats drop constraint %I', r.conname);
  end loop;
end $$;
alter table public.chats add constraint chats_type_check check (type in ('direct', 'group', 'ticket'));
alter table public.chats add constraint chats_name_check check (name is null or char_length(name) between 1 and 70);
alter table public.chats add column if not exists closed_at timestamptz;

-- ---------- Tabelle ----------
create sequence if not exists public.support_ticket_seq;

create table if not exists public.support_tickets (
  id uuid primary key default gen_random_uuid(),
  number int not null default nextval('public.support_ticket_seq'),
  chat_id uuid not null unique references public.chats(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  reason text not null,
  status text not null default 'open' check (status in ('open', 'closed')),
  closed_by uuid references public.profiles(id) on delete set null,
  closed_at timestamptz,
  user_deleted_at timestamptz,
  created_at timestamptz not null default now()
);
-- Ein Nutzer hat höchstens ein Ticket, solange er es nicht gelöscht hat
create unique index if not exists support_tickets_one_per_user on public.support_tickets(user_id) where user_deleted_at is null;
alter table public.support_tickets enable row level security;
revoke all on public.support_tickets from anon, authenticated;

-- ---------- Rechte im Ticket-Chat: nur schreiben (Text + Bilder), nur solange offen ----------
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

-- ---------- Systemzeilen im Ticket erlauben (sonst nur der Owner) ----------
create or replace function public._guard_system_messages()
returns trigger language plpgsql security definer set search_path = public, extensions as $$
begin
  if tg_op = 'INSERT' then
    if new.is_system and public.global_rank(auth.uid()) < 3
       and coalesce(current_setting('flarchat.ticket_system', true), '') <> 'on' then
      raise exception 'Systemnachrichten darf nur der Owner schreiben.';
    end if;
    if new.reply_to is not null and exists (select 1 from public.messages r where r.id = new.reply_to and r.is_system) then
      raise exception 'Auf Systemnachrichten kann man nicht antworten.';
    end if;
    return new;
  end if;
  if old.is_system then
    if new.is_system is distinct from old.is_system then
      raise exception 'Systemnachrichten können nicht geändert werden.';
    end if;
    if new.deleted_at is null and new.body is distinct from old.body then
      raise exception 'Systemnachrichten können nicht bearbeitet werden.';
    end if;
    if old.deleted_at is null and new.deleted_at is not null and public.global_rank(auth.uid()) < 3 then
      raise exception 'Systemnachrichten darf nur der Owner löschen.';
    end if;
  end if;
  return new;
end;
$$;

-- ---------- Im Ticket gesperrt: Umfragen, Sprachnachrichten, Weiterleiten, Reaktionen, Melden ----------
create or replace function public._guard_ticket_messages()
returns trigger language plpgsql security definer set search_path = public, extensions as $$
begin
  if exists (select 1 from public.chats where id = new.chat_id and type = 'ticket') then
    if new.poll_id is not null then
      raise exception 'Umfragen gibt es im Ticket nicht.';
    end if;
    if new.forwarded then
      raise exception 'Nachrichten können nicht in ein Ticket weitergeleitet werden.';
    end if;
    if new.media_path is not null and new.media_path ~* '\.(webm|m4a|ogg)$' then
      raise exception 'Sprachnachrichten gibt es im Ticket nicht.';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists messages_guard_ticket on public.messages;
create trigger messages_guard_ticket before insert on public.messages
  for each row execute function public._guard_ticket_messages();

create or replace function public._guard_ticket_targets()
returns trigger language plpgsql security definer set search_path = public, extensions as $$
begin
  if exists (select 1 from public.chats where id = new.chat_id and type = 'ticket') then
    raise exception 'Im Ticket geht das nicht.';
  end if;
  return new;
end;
$$;

drop trigger if exists reactions_guard_ticket on public.message_reactions;
create trigger reactions_guard_ticket before insert on public.message_reactions
  for each row execute function public._guard_ticket_targets();

drop trigger if exists reports_guard_ticket on public.reports;
create trigger reports_guard_ticket before insert on public.reports
  for each row execute function public._guard_ticket_targets();

-- ---------- Verlassen nicht erlaubt; Nachrichten löschen nur im offenen Ticket ----------
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
  select r.system_key into v_key from public.chat_members m
    left join public.chat_roles r on r.id = m.role_id
    where m.chat_id = p_chat_id and m.user_id = v_uid;
  if v_key = 'owner' then
    raise exception 'Als Besitzer musst du zuerst die Besitzerrolle übertragen oder den Chat löschen.';
  end if;
  delete from public.chat_members where chat_id = p_chat_id and user_id = v_uid;
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
  if exists (select 1 from public.chats where id = v_m.chat_id and type = 'ticket' and closed_at is not null) then
    raise exception 'Das Ticket ist geschlossen.';
  end if;
  if v_m.sender_id <> v_uid and not public.has_chat_perm(v_m.chat_id, v_uid, 'delete_others_messages') then
    raise exception 'Du darfst diese Nachricht nicht löschen.';
  end if;
  perform public._soft_delete(p_message_id, v_uid);
end;
$$;

-- ---------- Ticket-Systemzeile (intern) ----------
create or replace function public._ticket_system_line(p_chat uuid, p_sender uuid, p_body text)
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  perform set_config('flarchat.ticket_system', 'on', true);
  insert into public.messages(chat_id, sender_id, body, is_system, created_at)
  values (p_chat, p_sender, p_body, true, clock_timestamp());
  perform set_config('flarchat.ticket_system', '', true);
end;
$$;

-- ---------- Mein Ticket (null Zeilen = keins) ----------
create or replace function public.my_support_ticket()
returns table (chat_id uuid, number int, status text)
language plpgsql stable security definer set search_path = public, extensions as $$
#variable_conflict use_column
declare
  v_uid uuid := public._me();
begin
  return query
    select t.chat_id, t.number, t.status from public.support_tickets t
    where t.user_id = v_uid and t.user_deleted_at is null;
end;
$$;

-- ---------- Ticket öffnen ----------
create or replace function public.open_support_ticket(p_category text, p_text text)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._me();
  v_text text := btrim(coalesce(p_text, ''));
  v_old public.support_tickets;
  v_num int;
  v_name text;
  v_chat uuid;
begin
  if p_category is null or p_category not in ('Frage', 'Problem / Fehler', 'Jemand melden / Beschwerde', 'Konto-Hilfe', 'Sonstiges') then
    raise exception 'Bitte wähle einen Grund aus.';
  end if;
  if char_length(v_text) < 10 or char_length(v_text) > 500 then
    raise exception 'Bitte schreibe 10 bis 500 Zeichen.';
  end if;
  if exists (select 1 from public.profiles where id = v_uid and muted_until > now()) then
    raise exception 'Du bist stummgeschaltet und kannst kein Ticket öffnen.';
  end if;
  select * into v_old from public.support_tickets where user_id = v_uid and user_deleted_at is null;
  if found then
    if v_old.status = 'open' then
      raise exception 'Du hast schon ein offenes Ticket.';
    end if;
    raise exception 'Dein altes Ticket ist geschlossen. Lösche es zuerst, dann kannst du ein neues öffnen.';
  end if;

  v_num := nextval('public.support_ticket_seq');
  select 'Ticket ' || display_name || ' #' || lpad(v_num::text, 4, '0') into v_name from public.profiles where id = v_uid;
  begin
    insert into public.chats(type, name, avatar_url, created_by)
    values ('ticket', v_name, 'emoji:🎫|#3498DB', v_uid) returning id into v_chat;
    insert into public.chat_members(chat_id, user_id) values (v_chat, v_uid);
    insert into public.chat_members(chat_id, user_id)
      select v_chat, p.id from public.profiles p
      where p.global_role in ('moderator', 'admin', 'owner') and not p.banned and p.id <> v_uid;
    insert into public.support_tickets(number, chat_id, user_id, reason) values (v_num, v_chat, v_uid, p_category);
    perform public._ticket_system_line(v_chat, v_uid, 'Ticket eröffnet');
    insert into public.messages(chat_id, sender_id, body, created_at)
    values (v_chat, v_uid, 'Grund: ' || p_category || E'\n' || v_text, clock_timestamp());
  exception when unique_violation then
    raise exception 'Du hast schon ein Ticket.';
  end;
  return v_chat;
end;
$$;

-- ---------- Ticket schließen (Team) ----------
create or replace function public.close_support_ticket(p_chat_id uuid)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._need_rank(1, 'Nur das Team darf Tickets schließen.');
  v_t public.support_tickets;
  v_name text;
begin
  select * into v_t from public.support_tickets where chat_id = p_chat_id for update;
  if not found then
    raise exception 'Ticket nicht gefunden.';
  end if;
  if v_t.status <> 'open' then
    raise exception 'Dieses Ticket ist schon geschlossen.';
  end if;
  select display_name into v_name from public.profiles where id = v_uid;
  perform public._ticket_system_line(p_chat_id, v_uid, 'Ticket geschlossen von ' || coalesce(v_name, 'dem Team'));
  update public.support_tickets set status = 'closed', closed_by = v_uid, closed_at = now() where id = v_t.id;
  update public.chats set closed_at = now() where id = p_chat_id;
  -- Das Ticket verschwindet bei allen Teamlern. Der Owner liest es im Admin-Panel.
  delete from public.chat_members where chat_id = p_chat_id and user_id <> v_t.user_id;
  perform public._audit('support_ticket_close', p_chat_id::text, jsonb_build_object('number', v_t.number));
end;
$$;

-- ---------- Geschlossenes Ticket selbst löschen (nur bei mir weg) ----------
create or replace function public.delete_my_support_ticket(p_chat_id uuid)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._me();
  v_t public.support_tickets;
begin
  select * into v_t from public.support_tickets
   where chat_id = p_chat_id and user_id = v_uid and user_deleted_at is null for update;
  if not found then
    raise exception 'Ticket nicht gefunden.';
  end if;
  if v_t.status <> 'closed' then
    raise exception 'Ein offenes Ticket kann man nicht löschen.';
  end if;
  delete from public.chat_members where chat_id = p_chat_id and user_id = v_uid;
  update public.support_tickets set user_deleted_at = now() where id = v_t.id;
end;
$$;

-- ---------- Neue Teamler kommen in offene Tickets, ehemalige Teamler gehen raus ----------
create or replace function public._sync_ticket_team()
returns trigger language plpgsql security definer set search_path = public, extensions as $$
begin
  if new.global_role is not distinct from old.global_role then
    return new;
  end if;
  if old.global_role = 'user' and new.global_role <> 'user' and not new.banned then
    insert into public.chat_members(chat_id, user_id)
      select c.id, new.id from public.chats c where c.type = 'ticket' and c.closed_at is null
    on conflict do nothing;
  elsif new.global_role = 'user' then
    delete from public.chat_members m using public.support_tickets t
     where t.chat_id = m.chat_id and t.status = 'open' and m.user_id = new.id and t.user_id <> new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_sync_ticket_team on public.profiles;
create trigger profiles_sync_ticket_team after update of global_role on public.profiles
  for each row execute function public._sync_ticket_team();

-- ---------- Owner: alle Tickets im Admin-Panel (auch geschlossene und gelöschte) ----------
create or replace function public.admin_list_support_tickets()
returns table (number int, chat_id uuid, name text, username text, display_name text, reason text, status text,
               created_at timestamptz, closed_at timestamptz, closed_by_username text, user_deleted_at timestamptz,
               message_count int)
language plpgsql security definer set search_path = public, extensions as $$
#variable_conflict use_column
declare
  v_uid uuid := public._need_admin_unlocked();
begin
  perform public._audit('admin_list_support_tickets', null, '{}'::jsonb);
  return query
    select t.number, t.chat_id, c.name, p.username, p.display_name, t.reason, t.status,
           t.created_at, t.closed_at, cb.username, t.user_deleted_at,
           (select count(*)::int from public.messages m where m.chat_id = t.chat_id and not m.is_system)
    from public.support_tickets t
    join public.chats c on c.id = t.chat_id
    join public.profiles p on p.id = t.user_id
    left join public.profiles cb on cb.id = t.closed_by
    order by t.number desc;
end;
$$;

-- ---------- Chatliste: Ticket-Status ----------
create or replace view public.chat_overview as
select
  c.id as chat_id,
  case when c.type = 'direct' then peer.display_name else c.name end as name,
  c.type,
  case when c.type = 'direct' then peer.avatar_url else c.avatar_url end as avatar_url,
  c.verified,
  lm.body as last_message_body,
  lm.created_at as last_message_at,
  lm.sender_id as last_message_sender,
  (select count(*)::int from public.messages m
    where m.chat_id = c.id and m.deleted_at is null
      and m.sender_id <> me.user_id and m.created_at > me.last_read_at) as unread_count,
  me.role_id as my_role_id,
  peer.id as peer_user_id,
  lm.is_system as last_message_is_system,
  case when c.type = 'ticket' then case when c.closed_at is null then 'open' else 'closed' end end as ticket_status
from public.chat_members me
join public.chats c on c.id = me.chat_id
left join lateral (
  select p.id, p.display_name, p.avatar_url
  from public.chat_members cm join public.profiles p on p.id = cm.user_id
  where c.type = 'direct' and cm.chat_id = c.id and cm.user_id <> me.user_id
  limit 1
) peer on true
left join lateral (
  select case when m.deleted_at is null then m.body else null end as body, m.created_at, m.sender_id, m.is_system
  from public.messages m
  where m.chat_id = c.id
  order by m.created_at desc
  limit 1
) lm on true
where me.user_id = auth.uid();

grant select on public.chat_overview to authenticated;

-- ---------- Rechte ----------
revoke all on function public._ticket_system_line(uuid, uuid, text), public._guard_ticket_messages(),
  public._guard_ticket_targets(), public._sync_ticket_team() from public, anon, authenticated;
revoke all on function public.my_support_ticket(), public.open_support_ticket(text, text), public.close_support_ticket(uuid),
  public.delete_my_support_ticket(uuid), public.admin_list_support_tickets() from public, anon;
grant execute on function public.my_support_ticket(), public.open_support_ticket(text, text), public.close_support_ticket(uuid),
  public.delete_my_support_ticket(uuid), public.admin_list_support_tickets() to authenticated;
