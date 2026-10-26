-- 026: Systemnachrichten (nur der Owner schreibt sie, im Admin-Panel). Idempotent.

alter table public.messages add column if not exists is_system boolean not null default false;

-- Schutz: Nur der Owner darf Systemnachrichten anlegen oder löschen. Niemand darf sie ändern,
-- darauf antworten, darauf reagieren oder sie melden.
create or replace function public._guard_system_messages()
returns trigger language plpgsql security definer set search_path = public, extensions as $$
begin
  if tg_op = 'INSERT' then
    if new.is_system and public.global_rank(auth.uid()) < 3 then
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

drop trigger if exists messages_guard_system on public.messages;
create trigger messages_guard_system before insert or update on public.messages
  for each row execute function public._guard_system_messages();

create or replace function public._guard_system_targets()
returns trigger language plpgsql security definer set search_path = public, extensions as $$
begin
  if exists (select 1 from public.messages m where m.id = new.message_id and m.is_system) then
    raise exception 'Bei Systemnachrichten geht das nicht.';
  end if;
  return new;
end;
$$;

drop trigger if exists reactions_guard_system on public.message_reactions;
create trigger reactions_guard_system before insert on public.message_reactions
  for each row execute function public._guard_system_targets();

drop trigger if exists reports_guard_system on public.reports;
create trigger reports_guard_system before insert on public.reports
  for each row execute function public._guard_system_targets();

-- ---------- Owner: Systemnachricht senden / löschen ----------
create or replace function public.admin_send_system_message(p_chat_id uuid, p_body text)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._need_admin_unlocked();
  v_body text := btrim(coalesce(p_body, ''));
  v_id uuid;
begin
  if char_length(v_body) not between 1 and 500 then
    raise exception 'Die Systemnachricht muss 1 bis 500 Zeichen lang sein.';
  end if;
  if not exists (select 1 from public.chats where id = p_chat_id) then
    raise exception 'Chat nicht gefunden.';
  end if;
  insert into public.messages(chat_id, sender_id, body, is_system)
  values (p_chat_id, v_uid, v_body, true) returning id into v_id;
  perform public._audit('admin_system_message', p_chat_id::text, jsonb_build_object('message_id', v_id, 'text', v_body));
  return v_id;
end;
$$;

create or replace function public.admin_delete_system_message(p_message_id uuid)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._need_admin_unlocked();
begin
  if not exists (select 1 from public.messages where id = p_message_id and is_system) then
    raise exception 'Systemnachricht nicht gefunden.';
  end if;
  perform public._soft_delete(p_message_id, v_uid);
  perform public._audit('admin_system_message_delete', p_message_id::text, '{}'::jsonb);
end;
$$;

-- ---------- Admin liest Chat: jetzt mit is_system ----------
drop function if exists public.admin_chat_messages(uuid, timestamptz, int);
create function public.admin_chat_messages(p_chat_id uuid, p_before timestamptz default now(), p_limit int default 100)
returns table (id uuid, chat_id uuid, sender_id uuid, sender_username text, body text, media_path text,
               reply_to uuid, created_at timestamptz, edited_at timestamptz, deleted_at timestamptz,
               deleted_by uuid, edits jsonb, is_system boolean)
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
                     from public.message_edits e where e.message_id = m.id), '[]'::jsonb),
           m.is_system
    from public.messages m
    left join public.deleted_message_content d on d.message_id = m.id
    left join public.profiles sp on sp.id = m.sender_id
    where m.chat_id = p_chat_id and m.created_at < coalesce(p_before, now())
    order by m.created_at desc
    limit v_limit;
end;
$$;

-- ---------- Chatliste: "SYSTEM: …" in der Vorschau ----------
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
  lm.is_system as last_message_is_system
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
grant execute on function public.admin_send_system_message(uuid, text), public.admin_delete_system_message(uuid),
  public.admin_chat_messages(uuid, timestamptz, int) to authenticated;
