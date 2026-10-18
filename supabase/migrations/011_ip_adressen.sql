-- 011: IP-Adressen beim Start der App speichern. Nur Admin und Owner dürfen sie sehen.

create table if not exists public.login_ips (
  user_id uuid not null references public.profiles(id) on delete cascade,
  ip text not null,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  primary key (user_id, ip)
);
alter table public.login_ips enable row level security;
revoke all on public.login_ips from anon, authenticated;

create or replace function public.record_login_ip()
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._me();
  v_ip text;
begin
  begin
    v_ip := btrim(split_part(coalesce(current_setting('request.headers', true)::json ->> 'x-forwarded-for', ''), ',', 1));
  exception when others then
    v_ip := null;
  end;
  if v_ip is null or v_ip = '' or char_length(v_ip) > 64 then
    return;
  end if;
  insert into public.login_ips(user_id, ip) values (v_uid, v_ip)
  on conflict (user_id, ip) do update set last_seen = now();
end;
$$;

create or replace function public.list_user_ips(p_user_id uuid)
returns table (ip text, first_seen timestamptz, last_seen timestamptz)
language plpgsql stable security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._need_rank(2, 'Hallo!' ||
  );
begin
  return query select l.ip, l.first_seen, l.last_seen from public.login_ips l
    where l.user_id = p_user_id order by l.last_seen desc limit 20;
end;
$$;

revoke all on function public.record_login_ip(), public.list_user_ips(uuid) from public, anon, authenticated;
grant execute on function public.record_login_ip(), public.list_user_ips(uuid) to authenticated;
