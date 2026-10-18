-- 009: Erwähnungen (@rolle nur für Owner/Admin), Umfragen, Anpinnen für App-Owner/Admin

-- ===== Fix: Antworten auf Nachrichten (RLS-Fehler) =====
-- Vorher wurde "reply_to" in der Unterabfrage mit der Spalte der alten Nachricht verwechselt.
create or replace function public.rls_reply_ok(p_chat uuid, p_reply uuid)
returns boolean language sql stable security definer set search_path = public, extensions as $$
  select exists (select 1 from public.messages r where r.id = p_reply and r.chat_id = p_chat);
$$;
revoke all on function public.rls_reply_ok(uuid, uuid) from public, anon;
grant execute on function public.rls_reply_ok(uuid, uuid) to authenticated;

drop policy if exists messages_insert on public.messages;
create policy messages_insert on public.messages for insert to authenticated
  with check (
    sender_id = auth.uid()
    and public.rls_can_send(chat_id, media_path is not null)
    and (media_path is null or media_path like chat_id::text || '/%')
    and (reply_to is null or public.rls_reply_ok(chat_id, reply_to))
  );

-- ===== @rolle nur für App-Owner/Admin =====
create or replace function public._check_role_mentions()
returns trigger language plpgsql security definer set search_path = public, extensions as $$
declare
  r record;
  v_name text;
begin
  if new.body is null or position('@' in new.body) = 0 then
    return new;
  end if;
  if public.global_rank(new.sender_id) >= 2 then
    return new;
  end if;
  for r in select name from public.chat_roles where chat_id = new.chat_id loop
    v_name := regexp_replace(lower(r.name), '\s+', '', 'g');
    v_name := regexp_replace(v_name, '([.^$*+?(){}|\[\]\\])', '\\\1', 'g');
    if v_name <> '' and lower(new.body) ~ ('@' || v_name || '([^[:alnum:]_]|$)') then
      raise exception 'Nur Owner und Admins dürfen Rollen erwähnen (@rolle).';
    end if;
  end loop;
  return new;
end;
$$;

drop trigger if exists messages_check_role_mentions on public.messages;
create trigger messages_check_role_mentions before insert on public.messages
  for each row execute function public._check_role_mentions();

-- ===== Umfragen =====
create table if not exists public.polls (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references public.chats(id) on delete cascade,
  created_by uuid references public.profiles(id) on delete set null,
  question text not null check (char_length(question) between 1 and 200),
  options text[] not null check (array_length(options, 1) between 2 and 6),
  created_at timestamptz not null default now()
);
create table if not exists public.poll_votes (
  poll_id uuid not null references public.polls(id) on delete cascade,
  chat_id uuid not null references public.chats(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  option_idx int not null check (option_idx between 0 and 5),
  primary key (poll_id, user_id)
);
create index if not exists polls_chat_idx on public.polls(chat_id);
create index if not exists poll_votes_chat_idx on public.poll_votes(chat_id);

alter table public.messages add column if not exists poll_id uuid references public.polls(id) on delete set null;

alter table public.polls enable row level security;
alter table public.poll_votes enable row level security;
drop policy if exists polls_select on public.polls;
create policy polls_select on public.polls for select to authenticated using (public.rls_is_member(chat_id));
drop policy if exists poll_votes_select on public.poll_votes;
create policy poll_votes_select on public.poll_votes for select to authenticated using (public.rls_is_member(chat_id));

revoke all on public.polls, public.poll_votes from anon, authenticated;
grant select on public.polls, public.poll_votes to authenticated;

create or replace function public.create_poll(p_chat_id uuid, p_question text, p_options text[])
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._me();
  v_q text := btrim(coalesce(p_question, ''));
  v_opts text[];
  v_poll uuid;
  v_msg uuid;
begin
  if not public.is_chat_member(p_chat_id, v_uid) then
    raise exception 'Du bist kein Mitglied dieses Chats.';
  end if;
  if not public.rls_can_send(p_chat_id, false) then
    raise exception 'Du darfst hier gerade nichts senden.';
  end if;
  if v_q = '' or char_length(v_q) > 200 then
    raise exception 'Die Frage muss 1 bis 200 Zeichen haben.';
  end if;
  select coalesce(array_agg(btrim(o)), '{}') into v_opts from unnest(p_options) o where btrim(o) <> '';
  if coalesce(array_length(v_opts, 1), 0) < 2 or array_length(v_opts, 1) > 6 then
    raise exception 'Eine Umfrage braucht 2 bis 6 Antworten.';
  end if;
  if exists (select 1 from unnest(v_opts) o where char_length(o) > 80) then
    raise exception 'Eine Antwort darf höchstens 80 Zeichen haben.';
  end if;
  insert into public.polls(chat_id, created_by, question, options) values (p_chat_id, v_uid, v_q, v_opts) returning id into v_poll;
  insert into public.messages(chat_id, sender_id, body, poll_id)
    values (p_chat_id, v_uid, '📊 ' || v_q, v_poll) returning id into v_msg;
  return v_msg;
end;
$$;

-- Gleiche Antwort nochmal = Stimme zurücknehmen. Andere Antwort = Stimme ändern.
create or replace function public.vote_poll(p_poll_id uuid, p_option int)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._me();
  v_poll public.polls;
  v_old int;
begin
  select * into v_poll from public.polls where id = p_poll_id;
  if not found or not public.is_chat_member(v_poll.chat_id, v_uid) then
    raise exception 'Umfrage nicht gefunden.';
  end if;
  if exists (select 1 from public.messages where poll_id = p_poll_id and deleted_at is not null) then
    raise exception 'Diese Umfrage wurde gelöscht.';
  end if;
  if p_option is null or p_option < 0 or p_option >= array_length(v_poll.options, 1) then
    raise exception 'Ungültige Antwort.';
  end if;
  select option_idx into v_old from public.poll_votes where poll_id = p_poll_id and user_id = v_uid;
  if v_old = p_option then
    delete from public.poll_votes where poll_id = p_poll_id and user_id = v_uid;
    return;
  end if;
  insert into public.poll_votes(poll_id, chat_id, user_id, option_idx) values (p_poll_id, v_poll.chat_id, v_uid, p_option)
    on conflict (poll_id, user_id) do update set option_idx = excluded.option_idx;
end;
$$;

revoke all on function public.create_poll(uuid, text, text[]), public.vote_poll(uuid, int) from public, anon, authenticated;
grant execute on function public.create_poll(uuid, text, text[]), public.vote_poll(uuid, int) to authenticated;

alter table public.poll_votes replica identity full;
do $$
declare
  t text;
begin
  foreach t in array array['polls', 'poll_votes'] loop
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- ===== Anpinnen: App-Owner/Admin dürfen in jedem Chat anpinnen (auch ohne Mitglied) =====
create or replace function public.pin_message(p_chat_id uuid, p_message_id uuid)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._me();
begin
  if public.global_rank(v_uid) < 2 then
    perform public._need_chat_perm(p_chat_id, 'pin_messages');
  end if;
  if not exists (select 1 from public.chats where id = p_chat_id) then
    raise exception 'Chat nicht gefunden.';
  end if;
  if not public._is_group(p_chat_id) then
    raise exception 'Anheften ist nur in Gruppen möglich.';
  end if;
  if p_message_id is not null and not exists (
      select 1 from public.messages where id = p_message_id and chat_id = p_chat_id and deleted_at is null) then
    raise exception 'Nachricht nicht gefunden.';
  end if;
  update public.chats set pinned_message_id = p_message_id where id = p_chat_id;
  if public.global_rank(v_uid) >= 2 and not public.is_chat_member(p_chat_id, v_uid) then
    perform public._audit('admin_pin_message', p_chat_id::text, jsonb_build_object('message_id', p_message_id));
  end if;
end;
$$;
