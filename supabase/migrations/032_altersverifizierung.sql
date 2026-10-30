-- 032: Altersverifizierung (Mindestalter 14). Idempotent.
-- Wichtig: Nach dem Ausführen sind ALLE Nutzer außer Owner gesperrt, bis das Team sie geprüft hat.
-- Owner sind immer geprüft. Niemand prüft sich selbst.
-- Wer chat_overview später neu definiert, muss "public._age_ok(auth.uid())" im where behalten.

-- ---------- Tabellen (keine Policies: nur über security-definer-Funktionen erreichbar) ----------
create table if not exists public.age_records (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  birth_date date,
  verified boolean not null default false,
  verified_at timestamptz,
  verified_by uuid references public.profiles(id) on delete set null,
  too_young boolean not null default false,
  is_guardian boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.age_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  method text not null check (method in ('ausweis', 'buerge')),
  guardian_id uuid references public.profiles(id) on delete set null,
  status text not null default 'open'
    check (status in ('guardian_wait', 'open', 'mod_ok', 'mod_no', 'approved', 'rejected')),
  reject_reason text,
  mod_id uuid references public.profiles(id) on delete set null,
  mod_at timestamptz,
  mod_note text,
  final_by uuid references public.profiles(id) on delete set null,
  final_at timestamptz,
  consent_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create unique index if not exists age_requests_one_active
  on public.age_requests(user_id) where status in ('guardian_wait', 'open', 'mod_ok', 'mod_no');
create index if not exists age_requests_status_idx on public.age_requests(status, created_at);
create index if not exists age_requests_guardian_idx on public.age_requests(guardian_id);

-- Foto getrennt, damit Listen es nie mitladen
create table if not exists public.age_photos (
  request_id uuid primary key references public.age_requests(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  data text not null check (char_length(data) <= 2500000),
  created_at timestamptz not null default now()
);

alter table public.age_records enable row level security;
alter table public.age_requests enable row level security;
alter table public.age_photos enable row level security;
revoke all on public.age_records, public.age_requests, public.age_photos from anon, authenticated;

-- ---------- Helper ----------
-- Owner sind immer geprüft, alle anderen nur mit verified = true
create or replace function public._age_ok(p_user uuid)
returns boolean language sql stable security definer set search_path = public, extensions as $$
select exists (select 1 from public.profiles where id = p_user and global_role = 'owner')
    or exists (select 1 from public.age_records where user_id = p_user and verified);
$$;

create or replace function public._age_years(p_birth date)
returns int language sql stable as $$
select extract(year from age(current_date, p_birth))::int;
$$;

-- Alte _me(): nur angemeldet und nicht gesperrt (für die Alters-Funktionen selbst)
create or replace function public._me_any()
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

-- Neue _me(): zusätzlich muss das Alter geprüft sein (Owner immer)
create or replace function public._me()
returns uuid language plpgsql stable security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._me_any();
begin
  if not public._age_ok(v_uid) then
    raise exception 'Bitte bestätige zuerst dein Alter.';
  end if;
  return v_uid;
end;
$$;

-- Diese beiden Funktionen müssen auch vor der Alterprüfung laufen
create or replace function public.accept_agb()
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._me_any();
begin
  update public.profiles set agb_accepted_at = now() where id = v_uid;
end;
$$;

create or replace function public.clear_must_change_password()
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._me_any();
begin
  update public.profiles set must_change_password = false where id = v_uid;
end;
$$;

-- ---------- Datenbank-Schutz: Ungeprüfte sehen und schreiben nichts ----------
create or replace function public.rls_is_member(p_chat uuid)
returns boolean language sql stable security definer set search_path = public, extensions as $$
select public.is_chat_member(p_chat, auth.uid())
           and not exists (select 1 from public.profiles where id = auth.uid() and banned)
           and public._age_ok(auth.uid());
$$;

create or replace function public.rls_can_send(p_chat uuid, p_media boolean)
returns boolean language sql stable security definer set search_path = public, extensions as $$
select auth.uid() is not null
           and public._age_ok(auth.uid())
           and exists (select 1 from public.profiles p
                       where p.id = auth.uid() and not p.banned
                         and (p.muted_until is null or p.muted_until <= now()))
           and public.has_chat_perm(p_chat, auth.uid(), 'send_messages')
           and (not p_media or public.has_chat_perm(p_chat, auth.uid(), 'send_media'));
$$;

create or replace function public.rls_can_see_profile(p_user uuid)
returns boolean language sql stable security definer set search_path = public, extensions as $$
select auth.uid() is not null and (
    p_user = auth.uid()
        or (public._age_ok(auth.uid()) and (
            public.global_rank(auth.uid()) >= 1
            or exists (select 1 from public.chat_members a join public.chat_members b on a.chat_id = b.chat_id
                       where a.user_id = auth.uid() and b.user_id = p_user)))
    );
$$;

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
where me.user_id = auth.uid() and public._age_ok(auth.uid());

grant select on public.chat_overview to authenticated;

-- ---------- Nutzer: eigener Stand ----------
create or replace function public.age_my_state()
returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._me_any();
  v_rec public.age_records;
  v_req public.age_requests;
  v_pos int;
begin
  select * into v_rec from public.age_records where user_id = v_uid;
  select * into v_req from public.age_requests where user_id = v_uid order by created_at desc limit 1;
  if v_req.status in ('open', 'mod_ok', 'mod_no') then
    select count(*)::int + 1 into v_pos from public.age_requests r
      where r.status in ('open', 'mod_ok', 'mod_no') and r.created_at < v_req.created_at;
  end if;
  return jsonb_build_object(
    'verified', public._age_ok(v_uid),
    'is_guardian', coalesce(v_rec.is_guardian, false),
    'birth_date', v_rec.birth_date,
    'too_young', coalesce(v_rec.too_young, false),
    'status', v_req.status,
    'method', v_req.method,
    'reject_reason', v_req.reject_reason,
    'position', v_pos
  );
end;
$$;

-- Formular absenden. p_photo = data:image/jpeg;base64,... (nur bei Ausweis)
create or replace function public.age_submit(p_birth date, p_method text, p_guardian text, p_photo text, p_consent boolean)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._me_any();
  v_rec public.age_records;
  v_birth date;
  v_g uuid;
  v_g_ok boolean;
  v_req uuid;
  v_status text;
begin
  if public._age_ok(v_uid) then
    raise exception 'Dein Alter ist schon bestätigt.';
  end if;
  if not coalesce(p_consent, false) then
    raise exception 'Bitte stimme dem Datenschutz-Text zu.';
  end if;
  if p_method not in ('ausweis', 'buerge') then
    raise exception 'Unbekannte Methode.';
  end if;
  if exists (select 1 from public.age_requests where user_id = v_uid and status in ('guardian_wait', 'open', 'mod_ok', 'mod_no')) then
    raise exception 'Du hast schon eine offene Prüfung.';
  end if;

  select * into v_rec from public.age_records where user_id = v_uid;
  -- Das Geburtsdatum kann nur das Team ändern: Ist schon eins gespeichert, gilt es
  v_birth := coalesce(v_rec.birth_date, p_birth);
  if v_birth is null then
    raise exception 'Bitte gib dein Geburtsdatum ein.';
  end if;
  if v_birth > current_date or v_birth < date '1900-01-01' then
    raise exception 'Dieses Geburtsdatum geht nicht.';
  end if;

  insert into public.age_records(user_id, birth_date) values (v_uid, v_birth)
  on conflict (user_id) do update set birth_date = coalesce(public.age_records.birth_date, excluded.birth_date);

  if public._age_years(v_birth) < 14 then
    update public.age_records set too_young = true where user_id = v_uid;
    return;
  end if;

  if p_method = 'ausweis' then
    if p_photo is null or p_photo !~ '^data:image/jpeg;base64,[A-Za-z0-9+/=]+$' or char_length(p_photo) < 2000 then
      raise exception 'Bitte lade ein Foto hoch.';
    end if;
    v_status := 'open';
  else
    select p.id into v_g from public.profiles p where p.username = lower(trim(coalesce(p_guardian, '')));
    if v_g is null or v_g = v_uid then
      raise exception 'Diesen Elternteil gibt es nicht.';
    end if;
    select (r.is_guardian and public._age_ok(v_g)) into v_g_ok from public.age_records r where r.user_id = v_g;
    if not coalesce(v_g_ok, false) then
      raise exception 'Diese Person darf nicht bürgen.';
    end if;
    if (select count(*) from public.age_requests q
        where q.guardian_id = v_g and q.status in ('guardian_wait', 'open', 'mod_ok', 'mod_no', 'approved')) >= 3 then
      raise exception 'Diese Person bürgt schon für 3 Personen.';
    end if;
    v_status := 'guardian_wait';
  end if;

  insert into public.age_requests(user_id, method, guardian_id, status, consent_at)
  values (v_uid, p_method, v_g, v_status, now())
  returning id into v_req;
  if p_method = 'ausweis' then
    insert into public.age_photos(request_id, user_id, data) values (v_req, v_uid, p_photo);
  end if;
end;
$$;

-- ---------- Bürge (Elternteil) ----------
create or replace function public.age_guardian_list()
returns table (request_id uuid, username text, display_name text, birth_date date, created_at timestamptz)
language plpgsql stable security definer set search_path = public, extensions as $$
#variable_conflict use_column
declare
  v_uid uuid := public._me();
begin
  return query
    select q.id, p.username, p.display_name, r.birth_date, q.created_at
    from public.age_requests q
    join public.profiles p on p.id = q.user_id
    left join public.age_records r on r.user_id = q.user_id
    where q.guardian_id = v_uid and q.status = 'guardian_wait'
    order by q.created_at;
end;
$$;

create or replace function public.age_guardian_answer(p_request uuid, p_ok boolean)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._me();
  v_q public.age_requests;
begin
  select * into v_q from public.age_requests where id = p_request and guardian_id = v_uid and status = 'guardian_wait' for update;
  if not found then
    raise exception 'Anfrage nicht gefunden.';
  end if;
  if p_ok then
    update public.age_requests set status = 'open' where id = p_request;
  else
    update public.age_requests set status = 'rejected', reject_reason = 'Der Elternteil hat abgelehnt.', final_at = now() where id = p_request;
  end if;
  perform public._audit('age_guardian_answer', v_q.user_id::text, jsonb_build_object('request', p_request, 'ok', p_ok));
end;
$$;

-- ---------- Team: Warteschlange und Entscheidungen ----------
create or replace function public.age_queue()
returns table (request_id uuid, user_id uuid, username text, display_name text, global_role text, birth_date date,
               years int, method text, guardian_username text, status text, mod_name text, mod_note text,
               has_photo boolean, created_at timestamptz)
language plpgsql stable security definer set search_path = public, extensions as $$
#variable_conflict use_column
declare
  v_uid uuid := public._need_rank(1, 'Nur das Team darf die Alterprüfung sehen.');
begin
  return query
    select q.id, q.user_id, p.username, p.display_name, p.global_role, r.birth_date,
           case when r.birth_date is null then null else public._age_years(r.birth_date) end,
           q.method, g.username, q.status, m.username, q.mod_note,
           exists (select 1 from public.age_photos ph where ph.request_id = q.id), q.created_at
    from public.age_requests q
    join public.profiles p on p.id = q.user_id
    left join public.age_records r on r.user_id = q.user_id
    left join public.profiles g on g.id = q.guardian_id
    left join public.profiles m on m.id = q.mod_id
    where q.status in ('open', 'mod_ok', 'mod_no') and q.user_id <> v_uid
    order by q.created_at;
end;
$$;

-- Foto ansehen: jeder Blick kommt ins Protokoll
create or replace function public.age_photo(p_request uuid)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._need_rank(1, 'Nur das Team darf Fotos ansehen.');
  v_data text;
  v_user uuid;
begin
  select ph.data, ph.user_id into v_data, v_user from public.age_photos ph where ph.request_id = p_request;
  if v_data is null then
    return null;
  end if;
  if v_user = v_uid then
    raise exception 'Du darfst dein eigenes Foto nicht prüfen.';
  end if;
  perform public._audit('age_view_photo', v_user::text, jsonb_build_object('request', p_request));
  return v_data;
end;
$$;

-- Mod-Vorprüfung (Admin/Owner können auch direkt entscheiden)
create or replace function public.age_mod_check(p_request uuid, p_ok boolean, p_note text default null)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._need_rank(1, 'Nur das Team darf prüfen.');
  v_q public.age_requests;
begin
  select * into v_q from public.age_requests where id = p_request and status in ('open', 'mod_ok', 'mod_no') for update;
  if not found then
    raise exception 'Anfrage nicht gefunden.';
  end if;
  if v_q.user_id = v_uid then
    raise exception 'Du darfst dich nicht selbst prüfen.';
  end if;
  update public.age_requests
     set status = case when p_ok then 'mod_ok' else 'mod_no' end,
         mod_id = v_uid, mod_at = now(), mod_note = left(nullif(trim(coalesce(p_note, '')), ''), 300)
   where id = p_request;
  perform public._audit('age_mod_check', v_q.user_id::text, jsonb_build_object('request', p_request, 'ok', p_ok));
end;
$$;

-- Endgültige Entscheidung: nur Admin und Owner
create or replace function public.age_decide(p_request uuid, p_ok boolean, p_reason text default null)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._need_rank(2, 'Nur Admins und der Owner entscheiden endgültig.');
  v_q public.age_requests;
  v_birth date;
begin
  select * into v_q from public.age_requests where id = p_request and status in ('open', 'mod_ok', 'mod_no') for update;
  if not found then
    raise exception 'Anfrage nicht gefunden.';
  end if;
  if v_q.user_id = v_uid then
    raise exception 'Du darfst dich nicht selbst prüfen.';
  end if;
  if p_ok then
    select birth_date into v_birth from public.age_records where user_id = v_q.user_id;
    if v_birth is null or public._age_years(v_birth) < 14 then
      raise exception 'Das Geburtsdatum passt nicht (unter 14).';
    end if;
    update public.age_requests set status = 'approved', final_by = v_uid, final_at = now(), reject_reason = null where id = p_request;
    update public.age_records set verified = true, verified_at = now(), verified_by = v_uid where user_id = v_q.user_id;
  else
    if coalesce(trim(p_reason), '') = '' then
      raise exception 'Bitte gib einen Grund an.';
    end if;
    update public.age_requests set status = 'rejected', final_by = v_uid, final_at = now(), reject_reason = left(trim(p_reason), 200) where id = p_request;
  end if;
  perform public._audit('age_decide', v_q.user_id::text, jsonb_build_object('request', p_request, 'ok', p_ok));
end;
$$;

-- Alle Nutzer mit Stand (für Admin/Owner)
create or replace function public.age_users()
returns table (user_id uuid, username text, display_name text, global_role text, verified boolean, owner_auto boolean,
               birth_date date, too_young boolean, is_guardian boolean, has_photo boolean)
language plpgsql stable security definer set search_path = public, extensions as $$
#variable_conflict use_column
declare
  v_uid uuid := public._need_rank(2, 'Nur Admins und der Owner dürfen das sehen.');
begin
  return query
    select p.id, p.username, p.display_name, p.global_role, public._age_ok(p.id), p.global_role = 'owner',
           r.birth_date, coalesce(r.too_young, false), coalesce(r.is_guardian, false),
           exists (select 1 from public.age_photos ph where ph.user_id = p.id)
    from public.profiles p
    left join public.age_records r on r.user_id = p.id
    order by public._age_ok(p.id), p.created_at;
end;
$$;

-- Direkt als geprüft markieren (Vertraute, zu junge Nutzer entsperren) oder wieder sperren. Admin und Owner.
create or replace function public.age_set_verified(p_user uuid, p_value boolean)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._need_rank(2, 'Nur Admins und der Owner dürfen das.');
begin
  if p_user = v_uid then
    raise exception 'Du darfst dich nicht selbst prüfen.';
  end if;
  if public.global_rank(p_user) >= public.global_rank(v_uid) and public.global_rank(v_uid) < 3 then
    raise exception 'Das darfst du bei dieser Person nicht.';
  end if;
  if exists (select 1 from public.profiles where id = p_user and global_role = 'owner') then
    raise exception 'Owner sind immer geprüft.';
  end if;
  insert into public.age_records(user_id, verified, verified_at, verified_by)
  values (p_user, p_value, case when p_value then now() end, case when p_value then v_uid end)
  on conflict (user_id) do update
    set verified = excluded.verified, verified_at = excluded.verified_at, verified_by = excluded.verified_by,
        too_young = case when p_value then false else public.age_records.too_young end;
  perform public._audit('age_set_verified', p_user::text, jsonb_build_object('value', p_value));
end;
$$;

-- Geburtsdatum ändern: nur Admin und Owner
create or replace function public.age_set_birth(p_user uuid, p_birth date)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._need_rank(2, 'Nur Admins und der Owner dürfen das.');
begin
  if p_birth is not null and (p_birth > current_date or p_birth < date '1900-01-01') then
    raise exception 'Dieses Geburtsdatum geht nicht.';
  end if;
  insert into public.age_records(user_id, birth_date) values (p_user, p_birth)
  on conflict (user_id) do update set birth_date = excluded.birth_date,
    too_young = p_birth is not null and public._age_years(p_birth) < 14;
  perform public._audit('age_set_birth', p_user::text, '{}'::jsonb);
end;
$$;

-- Elternteil-Häkchen: nur Owner
create or replace function public.age_set_guardian(p_user uuid, p_value boolean)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._need_rank(3, 'Nur der Owner darf das.');
begin
  insert into public.age_records(user_id, is_guardian) values (p_user, p_value)
  on conflict (user_id) do update set is_guardian = excluded.is_guardian;
  perform public._audit('age_set_guardian', p_user::text, jsonb_build_object('value', p_value));
end;
$$;

-- Fotos und Geburtsdatum löschen: nur Owner
create or replace function public.age_owner_delete(p_user uuid)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._need_rank(3, 'Nur der Owner darf das.');
begin
  delete from public.age_photos where user_id = p_user;
  update public.age_records set birth_date = null, too_young = false where user_id = p_user;
  perform public._audit('age_owner_delete', p_user::text, '{}'::jsonb);
end;
$$;

-- ---------- Rechte ----------
revoke all on function public._age_ok(uuid), public._age_years(date), public._me_any() from public, anon, authenticated;
revoke all on function
  public.age_my_state(), public.age_submit(date, text, text, text, boolean),
  public.age_guardian_list(), public.age_guardian_answer(uuid, boolean),
  public.age_queue(), public.age_photo(uuid), public.age_mod_check(uuid, boolean, text),
  public.age_decide(uuid, boolean, text), public.age_users(), public.age_set_verified(uuid, boolean),
  public.age_set_birth(uuid, date), public.age_set_guardian(uuid, boolean), public.age_owner_delete(uuid)
  from public, anon;
grant execute on function
  public.age_my_state(), public.age_submit(date, text, text, text, boolean),
  public.age_guardian_list(), public.age_guardian_answer(uuid, boolean),
  public.age_queue(), public.age_photo(uuid), public.age_mod_check(uuid, boolean, text),
  public.age_decide(uuid, boolean, text), public.age_users(), public.age_set_verified(uuid, boolean),
  public.age_set_birth(uuid, date), public.age_set_guardian(uuid, boolean), public.age_owner_delete(uuid)
  to authenticated;
