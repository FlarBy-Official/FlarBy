-- Erinnerungen an Nachrichten
create table if not exists public.reminders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  message_id uuid not null references public.messages(id) on delete cascade,
  chat_id uuid not null references public.chats(id) on delete cascade,
  remind_at timestamptz not null,
  delivered_at timestamptz,
  push_sent_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists reminders_user_time_idx on public.reminders(user_id, remind_at);
create index if not exists reminders_push_idx on public.reminders(remind_at) where push_sent_at is null;
alter table public.reminders enable row level security;
revoke all on public.reminders from anon, authenticated;

create or replace function public.create_reminder(p_message_id uuid, p_remind_at timestamptz)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._me();
  v_m public.messages;
  v_id uuid;
begin
  select * into v_m from public.messages where id = p_message_id;
  if not found or not public.is_chat_member(v_m.chat_id, v_uid) then
    raise exception 'Nachricht nicht gefunden.';
  end if;
  if p_remind_at is null or p_remind_at <= now() then
    raise exception 'Die Zeit muss in der Zukunft liegen.';
  end if;
  if p_remind_at > now() + interval '1 year' then
    raise exception 'Die Zeit darf höchstens 1 Jahr entfernt sein.';
  end if;
  if (select count(*) from public.reminders where user_id = v_uid and delivered_at is null) >= 50 then
    raise exception 'Du hast schon 50 offene Erinnerungen.';
  end if;
  insert into public.reminders(user_id, message_id, chat_id, remind_at)
  values (v_uid, v_m.id, v_m.chat_id, p_remind_at) returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.list_due_reminders()
returns table (id uuid, message_id uuid, chat_id uuid, remind_at timestamptz, body text, sender_username text, has_media boolean)
language plpgsql security definer set search_path = public, extensions as $$
declare v_uid uuid := public._me();
begin
  return query
  select r.id, r.message_id, r.chat_id, r.remind_at,
    case when m.deleted_at is null then coalesce(m.body, '') else '' end,
    p.username,
    (m.deleted_at is null and m.media_path is not null)
  from public.reminders r
  join public.messages m on m.id = r.message_id
  left join public.profiles p on p.id = m.sender_id
  where r.user_id = v_uid and r.delivered_at is null and r.remind_at <= now()
  order by r.remind_at;
end;
$$;

create or replace function public.mark_reminder_delivered(p_id uuid)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare v_uid uuid := public._me();
begin
  update public.reminders set delivered_at = now()
  where id = p_id and user_id = v_uid and delivered_at is null;
end;
$$;

create or replace function public.list_my_reminders()
returns table (id uuid, message_id uuid, chat_id uuid, remind_at timestamptz, body text, sender_username text, has_media boolean)
language plpgsql security definer set search_path = public, extensions as $$
declare v_uid uuid := public._me();
begin
  return query
  select r.id, r.message_id, r.chat_id, r.remind_at,
    case when m.deleted_at is null then coalesce(m.body, '') else '' end,
    p.username,
    (m.deleted_at is null and m.media_path is not null)
  from public.reminders r
  join public.messages m on m.id = r.message_id
  left join public.profiles p on p.id = m.sender_id
  where r.user_id = v_uid and r.delivered_at is null
  order by r.remind_at;
end;
$$;

create or replace function public.cancel_reminder(p_id uuid)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare v_uid uuid := public._me();
begin
  delete from public.reminders where id = p_id and user_id = v_uid;
end;
$$;

revoke all on function public.create_reminder(uuid, timestamptz) from public, anon;
revoke all on function public.list_due_reminders() from public, anon;
revoke all on function public.mark_reminder_delivered(uuid) from public, anon;
revoke all on function public.list_my_reminders() from public, anon;
revoke all on function public.cancel_reminder(uuid) from public, anon;
grant execute on function public.create_reminder(uuid, timestamptz) to authenticated;
grant execute on function public.list_due_reminders() to authenticated;
grant execute on function public.mark_reminder_delivered(uuid) to authenticated;
grant execute on function public.list_my_reminders() to authenticated;
grant execute on function public.cancel_reminder(uuid) to authenticated;
