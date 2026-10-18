-- 010: Avatare (Foto oder Emoji), Avatar-Meldungen, Avatar-Sperre, Dateianhang bei Meldungen

-- ===== Speicher =====
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', false, 1048576, array['image/jpeg'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('report-files', 'report-files', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- ===== Tabellen =====
-- Privater Zustand pro Person (nur über Funktionen sichtbar)
create table if not exists public.avatar_state (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  locked boolean not null default false,
  removals int not null default 0,
  notice text
);
alter table public.avatar_state enable row level security;
revoke all on public.avatar_state from anon, authenticated;

alter table public.chats add column if not exists avatar_removed_reason text;
alter table public.chats add column if not exists avatar_removed_at timestamptz;
alter table public.reports add column if not exists attachment_path text;

create table if not exists public.avatar_reports (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('user', 'chat')),
  target_user_id uuid references public.profiles(id) on delete cascade,
  target_chat_id uuid references public.chats(id) on delete cascade,
  reporter_id uuid not null references public.profiles(id) on delete cascade,
  reason text not null check (char_length(reason) between 1 and 500),
  attachment_path text,
  avatar_snapshot text,
  status text not null default 'open' check (status in ('open', 'resolved')),
  handled_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists avatar_reports_status_idx on public.avatar_reports(status, created_at desc);
alter table public.avatar_reports enable row level security;
revoke all on public.avatar_reports from anon, authenticated;

-- Direktes Ändern des Avatars ist nicht mehr erlaubt, nur noch über Funktionen
revoke update (avatar_url) on public.profiles from authenticated;

-- ===== Prüf-Helfer =====
create or replace function public._valid_avatar(p_value text, p_prefix text)
returns boolean language sql immutable set search_path = public, extensions as $$
  select p_value is null
      or p_value ~ '^emoji:[^|]{1,16}\|#[0-9a-fA-F]{6}$'
      or p_value ~ ('^img:' || p_prefix || '/[0-9a-f-]{36}\.jpg$');
$$;

create or replace function public.storage_avatar_ok(p_name text, p_ignore_lock boolean default false)
returns boolean language plpgsql stable security definer set search_path = public, extensions as $$
declare
  v_chat uuid;
begin
  if auth.uid() is null then
    return false;
  end if;
  if split_part(p_name, '/', 1) = 'u' then
    return split_part(p_name, '/', 2) = auth.uid()::text
       and p_name ~ '^u/[0-9a-f-]{36}/[0-9a-f-]{36}\.jpg$'
       and (p_ignore_lock or not coalesce((select s.locked from public.avatar_state s where s.user_id = auth.uid()), false));
  end if;
  if split_part(p_name, '/', 1) = 'c' then
    v_chat := public.storage_chat_id(split_part(p_name, '/', 2) || '/x');
    return v_chat is not null
       and p_name ~ '^c/[0-9a-f-]{36}/[0-9a-f-]{36}\.jpg$'
       and public._is_group(v_chat)
       and public.has_chat_perm(v_chat, auth.uid(), 'edit_chat_info');
  end if;
  return false;
end;
$$;

create or replace function public.rls_is_team()
returns boolean language sql stable security definer set search_path = public, extensions as $$
  select public.global_rank(auth.uid()) >= 1;
$$;

drop policy if exists avatars_select on storage.objects;
create policy avatars_select on storage.objects for select to authenticated using (bucket_id = 'avatars');
drop policy if exists avatars_insert on storage.objects;
create policy avatars_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars' and public.storage_avatar_ok(name));
drop policy if exists avatars_delete on storage.objects;
create policy avatars_delete on storage.objects for delete to authenticated
  using (bucket_id = 'avatars' and public.storage_avatar_ok(name, true));

drop policy if exists report_files_insert on storage.objects;
create policy report_files_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'report-files' and split_part(name, '/', 1) = auth.uid()::text);
drop policy if exists report_files_select on storage.objects;
create policy report_files_select on storage.objects for select to authenticated
  using (bucket_id = 'report-files' and (public.rls_is_team() or split_part(name, '/', 1) = auth.uid()::text));

-- ===== Eigenes Avatar =====
create or replace function public.set_my_avatar(p_value text)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._me();
begin
  if p_value is not null and coalesce((select locked from public.avatar_state where user_id = v_uid), false) then
    raise exception 'Avatare sind für dich vom Team gesperrt.';
  end if;
  if not public._valid_avatar(p_value, 'u/' || v_uid::text) then
    raise exception 'Ungültiges Avatar.';
  end if;
  update public.profiles set avatar_url = p_value where id = v_uid;
end;
$$;

create or replace function public.my_avatar_state()
returns table (locked boolean, notice text)
language plpgsql stable security definer set search_path = public, extensions as $$
#variable_conflict use_column
declare
  v_uid uuid := public._me();
begin
  return query select coalesce(s.locked, false), s.notice from (select v_uid as id) u left join public.avatar_state s on s.user_id = u.id;
end;
$$;

create or replace function public.clear_avatar_notice()
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._me();
begin
  update public.avatar_state set notice = null where user_id = v_uid;
end;
$$;

-- ===== Gruppen-Avatar =====
create or replace function public.set_chat_avatar(p_chat_id uuid, p_value text)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._need_chat_perm(p_chat_id, 'edit_chat_info');
begin
  if not public._is_group(p_chat_id) then
    raise exception 'Nur Gruppen haben ein Gruppenbild.';
  end if;
  if not public._valid_avatar(p_value, 'c/' || p_chat_id::text) then
    raise exception 'Ungültiges Avatar.';
  end if;
  update public.chats set avatar_url = p_value,
    avatar_removed_reason = case when p_value is null then avatar_removed_reason else null end,
    avatar_removed_at = case when p_value is null then avatar_removed_at else null end
  where id = p_chat_id;
end;
$$;

-- update_chat ändert nur noch den Namen (das Bild geht über set_chat_avatar)
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
  update public.chats set name = v_name where id = p_chat_id;
end;
$$;

-- ===== Meldungen mit Dateianhang =====
drop function if exists public.report_message(uuid, text);
create or replace function public.report_message(p_message_id uuid, p_reason text, p_attachment text default null)
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
  if p_attachment is not null and p_attachment not like v_uid::text || '/%' then
    raise exception 'Ungültiger Anhang.';
  end if;
  if exists (select 1 from public.reports where message_id = p_message_id and reporter_id = v_uid and status = 'open') then
    raise exception 'Du hast diese Nachricht bereits gemeldet.';
  end if;
  insert into public.reports(message_id, chat_id, reporter_id, reason, attachment_path)
    values (p_message_id, v_m.chat_id, v_uid, v_reason, p_attachment);
end;
$$;

create or replace function public.report_attachment(p_report_id uuid)
returns text language plpgsql stable security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._need_rank(1, 'Nur das Team darf Meldungen sehen.');
begin
  return (select attachment_path from public.reports where id = p_report_id);
end;
$$;

create or replace function public.report_avatar(p_kind text, p_target uuid, p_reason text, p_attachment text default null)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._me();
  v_reason text := btrim(coalesce(p_reason, ''));
  v_avatar text;
begin
  if char_length(v_reason) < 1 or char_length(v_reason) > 500 then
    raise exception 'Bitte gib einen Grund (max. 500 Zeichen) an.';
  end if;
  if p_attachment is not null and p_attachment not like v_uid::text || '/%' then
    raise exception 'Ungültiger Anhang.';
  end if;
  if p_kind = 'user' then
    if p_target = v_uid then
      raise exception 'Du kannst dein eigenes Avatar nicht melden.';
    end if;
    if not public.rls_can_see_profile(p_target) then
      raise exception 'Nutzer nicht gefunden.';
    end if;
    select avatar_url into v_avatar from public.profiles where id = p_target;
    if v_avatar is null then
      raise exception 'Diese Person hat kein Avatar.';
    end if;
    if exists (select 1 from public.avatar_reports where kind = 'user' and target_user_id = p_target and reporter_id = v_uid and status = 'open') then
      raise exception 'Du hast dieses Avatar bereits gemeldet.';
    end if;
    insert into public.avatar_reports(kind, target_user_id, reporter_id, reason, attachment_path, avatar_snapshot)
      values ('user', p_target, v_uid, v_reason, p_attachment, v_avatar);
  elsif p_kind = 'chat' then
    if not public.is_chat_member(p_target, v_uid) or not public._is_group(p_target) then
      raise exception 'Chat nicht gefunden.';
    end if;
    select avatar_url into v_avatar from public.chats where id = p_target;
    if v_avatar is null then
      raise exception 'Diese Gruppe hat kein Avatar.';
    end if;
    if exists (select 1 from public.avatar_reports where kind = 'chat' and target_chat_id = p_target and reporter_id = v_uid and status = 'open') then
      raise exception 'Du hast dieses Avatar bereits gemeldet.';
    end if;
    insert into public.avatar_reports(kind, target_chat_id, reporter_id, reason, attachment_path, avatar_snapshot)
      values ('chat', p_target, v_uid, v_reason, p_attachment, v_avatar);
  else
    raise exception 'Ungültige Meldung.';
  end if;
end;
$$;

-- ===== Team =====
create or replace function public.list_avatar_reports()
returns table (id uuid, kind text, target_user_id uuid, target_chat_id uuid, target_name text, target_username text,
               avatar text, reason text, attachment_path text, reporter_username text, status text,
               created_at timestamptz, removals int, locked boolean)
language plpgsql stable security definer set search_path = public, extensions as $$
#variable_conflict use_column
declare
  v_uid uuid := public._need_rank(1, 'Nur das Team darf Meldungen sehen.');
begin
  return query
    select r.id, r.kind, r.target_user_id, r.target_chat_id,
           coalesce(tp.display_name, tc.name), tp.username,
           coalesce(tp.avatar_url, tc.avatar_url), r.reason, r.attachment_path, rp.username, r.status, r.created_at,
           coalesce(s.removals, 0), coalesce(s.locked, false)
    from public.avatar_reports r
    left join public.profiles tp on tp.id = r.target_user_id
    left join public.chats tc on tc.id = r.target_chat_id
    left join public.profiles rp on rp.id = r.reporter_id
    left join public.avatar_state s on s.user_id = r.target_user_id
    order by (r.status = 'open') desc, r.created_at desc
    limit 200;
end;
$$;

create or replace function public.resolve_avatar_report(p_id uuid)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._need_rank(1, 'Nur das Team darf Meldungen bearbeiten.');
begin
  update public.avatar_reports set status = 'resolved', handled_by = v_uid where id = p_id;
end;
$$;

create or replace function public.avatar_state_list()
returns table (user_id uuid, locked boolean, removals int)
language plpgsql stable security definer set search_path = public, extensions as $$
#variable_conflict use_column
declare
  v_uid uuid := public._need_rank(1, 'Nur das Team darf das sehen.');
begin
  return query select s.user_id, s.locked, s.removals from public.avatar_state s;
end;
$$;

-- Entfernt das Avatar. Nach 5 Entfernungen wird die Sperre automatisch angeschaltet.
create or replace function public.team_remove_avatar(p_kind text, p_target uuid, p_reason text)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._need_rank(1, 'Nur das Team darf Avatare entfernen.');
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_count int;
  v_lock boolean;
begin
  if v_reason is not null and char_length(v_reason) > 200 then
    raise exception 'Der Grund darf höchstens 200 Zeichen haben.';
  end if;
  if p_kind = 'user' then
    perform public._check_target(v_uid, p_target);
    update public.profiles set avatar_url = null where id = p_target;
    insert into public.avatar_state(user_id, removals, notice) values (p_target, 1, null)
      on conflict (user_id) do update set removals = public.avatar_state.removals + 1;
    select removals into v_count from public.avatar_state where user_id = p_target;
    v_lock := v_count >= 5;
    update public.avatar_state set
      locked = locked or v_lock,
      notice = 'Dein Avatar wurde vom Team entfernt.' || coalesce(' Grund: ' || v_reason, '')
               || case when v_lock then ' Du hast jetzt keine Avatare mehr, weil das Avatar zu oft entfernt wurde.' else '' end
    where user_id = p_target;
    update public.avatar_reports set status = 'resolved', handled_by = v_uid
      where kind = 'user' and target_user_id = p_target and status = 'open';
    perform public._audit('remove_avatar', p_target::text, jsonb_build_object('reason', v_reason, 'removals', v_count, 'auto_locked', v_lock));
  elsif p_kind = 'chat' then
    if not exists (select 1 from public.chats where id = p_target and type = 'group') then
      raise exception 'Gruppe nicht gefunden.';
    end if;
    update public.chats set avatar_url = null, avatar_removed_reason = coalesce(v_reason, 'Ohne Angabe'), avatar_removed_at = now()
      where id = p_target;
    update public.avatar_reports set status = 'resolved', handled_by = v_uid
      where kind = 'chat' and target_chat_id = p_target and status = 'open';
    perform public._audit('remove_chat_avatar', p_target::text, jsonb_build_object('reason', v_reason));
  else
    raise exception 'Ungültige Angabe.';
  end if;
end;
$$;

-- Sperre von Hand an/aus. Beim Sperren wird das Avatar sofort entfernt (nur Buchstabe).
create or replace function public.set_avatar_lock(p_user_id uuid, p_locked boolean)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._need_rank(1, 'Nur das Team darf Avatare sperren.');
begin
  perform public._check_target(v_uid, p_user_id);
  insert into public.avatar_state(user_id, locked) values (p_user_id, coalesce(p_locked, false))
    on conflict (user_id) do update set locked = coalesce(p_locked, false);
  if p_locked then
    update public.profiles set avatar_url = null where id = p_user_id;
    update public.avatar_state set notice = 'Das Team hat Avatare für dich gesperrt.' where user_id = p_user_id;
  end if;
  perform public._audit('set_avatar_lock', p_user_id::text, jsonb_build_object('locked', p_locked));
end;
$$;

-- ===== Rechte =====
revoke all on function public.set_my_avatar(text), public.my_avatar_state(), public.clear_avatar_notice(),
  public.set_chat_avatar(uuid, text), public.update_chat(uuid, text, text),
  public.report_message(uuid, text, text), public.report_attachment(uuid), public.report_avatar(text, uuid, text, text),
  public.list_avatar_reports(), public.resolve_avatar_report(uuid), public.avatar_state_list(),
  public.team_remove_avatar(text, uuid, text), public.set_avatar_lock(uuid, boolean),
  public.storage_avatar_ok(text, boolean), public.rls_is_team()
  from public, anon, authenticated;
grant execute on function public.set_my_avatar(text), public.my_avatar_state(), public.clear_avatar_notice(),
  public.set_chat_avatar(uuid, text), public.update_chat(uuid, text, text),
  public.report_message(uuid, text, text), public.report_attachment(uuid), public.report_avatar(text, uuid, text, text),
  public.list_avatar_reports(), public.resolve_avatar_report(uuid), public.avatar_state_list(),
  public.team_remove_avatar(text, uuid, text), public.set_avatar_lock(uuid, boolean),
  public.storage_avatar_ok(text, boolean), public.rls_is_team()
  to authenticated;
