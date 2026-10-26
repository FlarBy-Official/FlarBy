-- 024: Admin-Panel Erweiterungen (Statistik, Codes, Aktivität, Ansage, Chat löschen, Wörter-Filter). Idempotent.
-- Alles nur für den Owner (über _need_admin_unlocked). Jede Aktion wird protokolliert.

-- ---------- Wörter-Filter ----------
create table if not exists public.banned_words (
  word text primary key check (char_length(word) between 2 and 40),
  created_at timestamptz not null default now()
);
alter table public.banned_words enable row level security;
revoke all on public.banned_words from anon, authenticated;

create or replace function public._check_banned_words()
returns trigger language plpgsql security definer set search_path = public, extensions as $$
begin
  if new.body is null or new.body = '' then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.body is not distinct from old.body then
    return new;
  end if;
  if public.global_rank(new.sender_id) >= 3 then
    return new;
  end if;
  if exists (select 1 from public.banned_words w where position(lower(w.word) in lower(new.body)) > 0) then
    raise exception 'Deine Nachricht enthält ein verbotenes Wort.';
  end if;
  return new;
end;
$$;

drop trigger if exists messages_banned_words on public.messages;
create trigger messages_banned_words before insert or update of body on public.messages
  for each row execute function public._check_banned_words();

create or replace function public.admin_list_words()
returns setof text language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._need_admin_unlocked();
begin
  return query select w.word from public.banned_words w order by w.word;
end;
$$;

create or replace function public.admin_add_word(p_word text)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._need_admin_unlocked();
  v_w text := lower(btrim(coalesce(p_word, '')));
begin
  if char_length(v_w) not between 2 and 40 then
    raise exception 'Das Wort muss 2 bis 40 Zeichen lang sein.';
  end if;
  insert into public.banned_words(word) values (v_w) on conflict do nothing;
  perform public._audit('admin_word_add', v_w, '{}'::jsonb);
end;
$$;

create or replace function public.admin_remove_word(p_word text)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._need_admin_unlocked();
begin
  delete from public.banned_words where word = lower(btrim(coalesce(p_word, '')));
  perform public._audit('admin_word_remove', lower(btrim(coalesce(p_word, ''))), '{}'::jsonb);
end;
$$;

-- ---------- Statistik ----------
create or replace function public.admin_stats()
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._need_admin_unlocked();
begin
  return jsonb_build_object(
    'users', (select count(*) from public.profiles),
    'users_new_7d', (select count(*) from public.profiles where created_at > now() - interval '7 days'),
    'online_now', (select count(*) from public.profiles where last_seen > now() - interval '5 minutes'),
    'active_today', (select count(*) from public.profiles where last_seen > now() - interval '1 day'),
    'banned', (select count(*) from public.profiles where banned),
    'chats', (select count(*) from public.chats),
    'groups', (select count(*) from public.chats where type = 'group'),
    'messages', (select count(*) from public.messages where deleted_at is null),
    'messages_today', (select count(*) from public.messages where created_at > now() - interval '1 day'),
    'images', (select count(*) from public.messages where media_path is not null and deleted_at is null),
    'open_reports', (select count(*) from public.reports where status = 'open'),
    'open_tickets', (select count(*) from public.tickets where status = 'open'));
end;
$$;

-- ---------- Aktivität (zuletzt online) ----------
create or replace function public.admin_users_activity()
returns table (id uuid, username text, display_name text, global_role text, banned boolean,
               last_seen timestamptz, created_at timestamptz, message_count int)
language plpgsql security definer set search_path = public, extensions as $$
#variable_conflict use_column
declare
  v_uid uuid := public._need_admin_unlocked();
begin
  return query
    select p.id, p.username, p.display_name, p.global_role, p.banned, p.last_seen, p.created_at,
           (select count(*)::int from public.messages m where m.sender_id = p.id and m.deleted_at is null)
    from public.profiles p
    order by p.last_seen desc nulls last, p.created_at desc;
end;
$$;

-- ---------- Einladungscodes ----------
create or replace function public.admin_list_codes()
returns table (id uuid, code text, kind text, chat_id uuid, chat_name text, created_at timestamptz,
               expires_at timestamptz, used_by_username text, used_at timestamptz, status text)
language plpgsql security definer set search_path = public, extensions as $$
#variable_conflict use_column
declare
  v_uid uuid := public._need_admin_unlocked();
begin
  return query
    select ic.id, public._fmt_code(ic.code), ic.kind, ic.chat_id, c.name, ic.created_at, ic.expires_at,
           u.username, ic.used_at,
           case when ic.used_at is not null then 'used'
                when ic.revoked then 'revoked'
                when ic.expires_at <= now() then 'expired'
                else 'active' end
    from public.invite_codes ic
    left join public.chats c on c.id = ic.chat_id
    left join public.profiles u on u.id = ic.used_by
    order by ic.created_at desc
    limit 300;
end;
$$;

create or replace function public.admin_revoke_code(p_code_id uuid)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._need_admin_unlocked();
begin
  update public.invite_codes set revoked = true where id = p_code_id and used_at is null;
  perform public._audit('admin_code_revoke', p_code_id::text, '{}'::jsonb);
end;
$$;

create or replace function public.admin_delete_code(p_code_id uuid)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._need_admin_unlocked();
begin
  delete from public.invite_codes where id = p_code_id;
  perform public._audit('admin_code_delete', p_code_id::text, '{}'::jsonb);
end;
$$;

-- ---------- Ansage an alle ----------
-- Liegt in app_settings (key 'announcement'), das alle angemeldeten Nutzer lesen dürfen.
create or replace function public.admin_set_announcement(p_text text)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._need_admin_unlocked();
  v_t text := btrim(coalesce(p_text, ''));
begin
  if char_length(v_t) > 300 then
    raise exception 'Die Ansage darf höchstens 300 Zeichen haben.';
  end if;
  insert into public.app_settings(key, value)
  values ('announcement', jsonb_build_object('text', v_t, 'id', gen_random_uuid()::text, 'at', now()))
  on conflict (key) do update set value = excluded.value;
  perform public._audit('admin_announcement', null, jsonb_build_object('text', v_t));
end;
$$;

-- ---------- Chat löschen ----------
create or replace function public.admin_chat_media(p_chat_id uuid)
returns setof text language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._need_admin_unlocked();
begin
  return query
    select m.media_path from public.messages m where m.chat_id = p_chat_id and m.media_path is not null
    union
    select d.media_path from public.deleted_message_content d
      join public.messages m on m.id = d.message_id where m.chat_id = p_chat_id and d.media_path is not null;
end;
$$;

create or replace function public.admin_delete_chat(p_chat_id uuid)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._need_admin_unlocked();
  v_name text;
begin
  select coalesce(name, 'Direktchat') into v_name from public.chats where id = p_chat_id;
  if not found then
    raise exception 'Chat nicht gefunden.';
  end if;
  update public.chats set pinned_message_id = null where id = p_chat_id;
  delete from public.chats where id = p_chat_id;
  perform public._audit('admin_chat_delete', p_chat_id::text, jsonb_build_object('name', v_name));
end;
$$;

-- Der Owner darf Chat-Bilder aus dem Speicher löschen (beim Löschen eines Chats).
drop policy if exists media_delete_owner on storage.objects;
create policy media_delete_owner on storage.objects for delete to authenticated
  using (bucket_id = 'media' and public.rls_is_owner());

grant execute on function
  public.admin_list_words(), public.admin_add_word(text), public.admin_remove_word(text),
  public.admin_stats(), public.admin_users_activity(), public.admin_list_codes(),
  public.admin_revoke_code(uuid), public.admin_delete_code(uuid), public.admin_set_announcement(text),
  public.admin_chat_media(uuid), public.admin_delete_chat(uuid)
  to authenticated;
