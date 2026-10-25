-- 014: Gesperrte Namen (everyone, admin, owner, moderator, mitglied)
-- 1) Bestehende Benutzer mit so einem Namen heißen danach user_001, user_002, ...
--    (Anmeldename und Anmelde-Daten werden mitgeändert, das Passwort bleibt.)
-- 2) Neue Benutzernamen und neue/umbenannte Rollen dürfen nicht so heißen.
-- 3) Eine Rolle darf nicht so heißen wie ein vorhandener Benutzer.

create or replace function public._reserved_name(p text)
returns boolean language sql immutable as $$
  select lower(coalesce(p, '')) in ('everyone', 'admin', 'owner', 'moderator', 'mitglied');
$$;

-- 1) Bestehende Benutzer umbenennen
do $$
declare
  r record;
  n int := 0;
  v_new text;
begin
  for r in select id, username, display_name from public.profiles
           where public._reserved_name(username) order by created_at, id loop
    loop
      n := n + 1;
      v_new := 'user_' || lpad(n::text, 3, '0');
      exit when not exists (select 1 from public.profiles where username = v_new);
    end loop;
    update public.profiles
       set username = v_new,
           display_name = case when display_name = r.username then v_new else display_name end
     where id = r.id;
    update auth.users
       set email = v_new || '@' || split_part(email, '@', 2),
           raw_user_meta_data = jsonb_set(coalesce(raw_user_meta_data, '{}'::jsonb), '{username}', to_jsonb(v_new))
     where id = r.id;
    update auth.identities
       set identity_data = jsonb_set(identity_data, '{email}', to_jsonb(v_new || '@' || split_part(identity_data->>'email', '@', 2)))
     where user_id = r.id and identity_data ? 'email';
    raise notice 'Benutzer % heißt jetzt %', r.username, v_new;
  end loop;
end;
$$;

-- 2) Neue Benutzernamen prüfen
create or replace function public._check_username()
returns trigger language plpgsql security definer set search_path = public, extensions as $$
begin
  if public._reserved_name(new.username) then
    raise exception 'Dieser Benutzername ist nicht erlaubt.';
  end if;
  return new;
end;
$$;

drop trigger if exists check_username on public.profiles;
create trigger check_username before insert or update of username on public.profiles
  for each row execute function public._check_username();

-- 3) Rollennamen prüfen (Systemrollen und unveränderte Namen sind ausgenommen)
create or replace function public._check_role_name()
returns trigger language plpgsql security definer set search_path = public, extensions as $$
declare
  v_key text := lower(regexp_replace(new.name, '\s+', '', 'g'));
begin
  if new.is_system then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.name is not distinct from old.name then
    return new;
  end if;
  if public._reserved_name(v_key) or exists (select 1 from public.profiles where username = v_key) then
    raise exception 'Dieser Rollenname ist nicht erlaubt.';
  end if;
  return new;
end;
$$;

drop trigger if exists check_role_name on public.chat_roles;
create trigger check_role_name before insert or update of name on public.chat_roles
  for each row execute function public._check_role_name();
