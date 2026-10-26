-- 012: Neueste IP jedes Nutzers für die Nutzerliste (nur Admin und Owner)

create or replace function public.latest_user_ips()
returns table (user_id uuid, ip text)
language plpgsql stable security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._need_rank(2, 'Nur Admins dürfen IP-Adressen sehen.');
begin
  return query select distinct on (l.user_id) l.user_id, l.ip from public.login_ips l
    order by l.user_id, l.last_seen desc;
end;
$$;

revoke all on function public.latest_user_ips() from public, anon, authenticated;
grant execute on function public.latest_user_ips() to authenticated;
