-- 018: Anmelde-Verlauf (Gerät, Browser, Sprache, Zeitzone, Bildschirm, ungefährer Ort) und Fehlerberichte
-- Alles sehen nur Admin und Owner. Der Ort kommt aus Kopfzeilen des Servers (cf-ipcity, cf-ipcountry).
-- Es wird nichts an fremde Dienste geschickt.

create table if not exists public.login_log (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  ip text,
  city text,
  country text,
  user_agent text,
  language text,
  timezone text,
  screen text,
  standalone boolean,
  created_at timestamptz not null default now()
);
create index if not exists login_log_user_idx on public.login_log(user_id, created_at desc);
alter table public.login_log enable row level security;
revoke all on public.login_log from anon, authenticated;

create table if not exists public.client_errors (
  id bigint generated always as identity primary key,
  user_id uuid references public.profiles(id) on delete cascade,
  message text not null,
  stack text,
  url text,
  user_agent text,
  created_at timestamptz not null default now()
);
create index if not exists client_errors_created_idx on public.client_errors(created_at desc);
alter table public.client_errors enable row level security;
revoke all on public.client_errors from anon, authenticated;

create or replace function public.record_login(p_info jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._me();
  v_h json;
  v_ip text;
  v_city text;
  v_country text;
  v_ua text := left(coalesce(p_info ->> 'ua', ''), 300);
begin
  begin
    v_h := current_setting('request.headers', true)::json;
    v_ip := btrim(split_part(coalesce(v_h ->> 'x-forwarded-for', ''), ',', 1));
    v_city := nullif(left(coalesce(v_h ->> 'cf-ipcity', ''), 80), '');
    v_country := nullif(left(coalesce(v_h ->> 'cf-ipcountry', ''), 8), '');
  exception when others then
    v_ip := null;
  end;
  if v_ip = '' or char_length(coalesce(v_ip, '')) > 64 then
    v_ip := null;
  end if;
  if v_ip is not null then
    insert into public.login_ips(user_id, ip) values (v_uid, v_ip)
    on conflict (user_id, ip) do update set last_seen = now();
  end if;
  if exists (select 1 from public.login_log l
             where l.user_id = v_uid and l.ip is not distinct from v_ip and l.user_agent = v_ua
               and l.created_at > now() - interval '30 minutes') then
    return;
  end if;
  insert into public.login_log(user_id, ip, city, country, user_agent, language, timezone, screen, standalone)
  values (v_uid, v_ip, v_city, v_country, v_ua,
          left(coalesce(p_info ->> 'lang', ''), 20), left(coalesce(p_info ->> 'tz', ''), 60),
          left(coalesce(p_info ->> 'screen', ''), 20), (p_info ->> 'standalone')::boolean);
end;
$$;

create or replace function public.list_user_logins(p_user_id uuid)
returns table (ip text, city text, country text, user_agent text, language text, timezone text, screen text,
               standalone boolean, created_at timestamptz)
language plpgsql stable security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._need_rank(2, 'Nur Admins dürfen den Anmelde-Verlauf sehen.');
begin
  return query select l.ip, l.city, l.country, l.user_agent, l.language, l.timezone, l.screen, l.standalone, l.created_at
    from public.login_log l where l.user_id = p_user_id order by l.created_at desc limit 50;
end;
$$;

create or replace function public.log_client_error(p_message text, p_stack text default null, p_url text default null, p_ua text default null)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._me();
begin
  if (select count(*) from public.client_errors where user_id = v_uid and created_at > now() - interval '1 hour') >= 20 then
    return;
  end if;
  insert into public.client_errors(user_id, message, stack, url, user_agent)
  values (v_uid, left(coalesce(p_message, '?'), 500), left(p_stack, 2000), left(p_url, 300), left(p_ua, 300));
end;
$$;

create or replace function public.list_client_errors()
returns table (id bigint, user_id uuid, username text, message text, stack text, url text, user_agent text, created_at timestamptz)
language plpgsql stable security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._need_rank(2, 'Nur Admins dürfen Fehlerberichte sehen.');
begin
  return query select e.id, e.user_id, p.username, e.message, e.stack, e.url, e.user_agent, e.created_at
    from public.client_errors e left join public.profiles p on p.id = e.user_id
    order by e.created_at desc limit 100;
end;
$$;

-- Reparatur: in 011 war die Fehlermeldung von list_user_ips kaputt geschrieben
create or replace function public.list_user_ips(p_user_id uuid)
returns table (ip text, first_seen timestamptz, last_seen timestamptz)
language plpgsql stable security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._need_rank(2, 'Nur Admins dürfen IP-Adressen sehen.');
begin
  return query select l.ip, l.first_seen, l.last_seen from public.login_ips l
    where l.user_id = p_user_id order by l.last_seen desc limit 20;
end;
$$;

revoke all on function public.record_login(jsonb), public.list_user_logins(uuid), public.log_client_error(text, text, text, text),
  public.list_client_errors(), public.list_user_ips(uuid) from public, anon, authenticated;
grant execute on function public.record_login(jsonb), public.list_user_logins(uuid), public.log_client_error(text, text, text, text),
  public.list_client_errors(), public.list_user_ips(uuid) to authenticated;
