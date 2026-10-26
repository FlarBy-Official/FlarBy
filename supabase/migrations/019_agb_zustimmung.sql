-- 019: AGB-Zustimmung für bestehende Nutzer
-- my_profile() liefert "select *" aus profiles, die neue Spalte ist also automatisch dabei.
alter table public.profiles add column if not exists agb_accepted_at timestamptz;

create or replace function public.accept_agb()
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._me();
begin
  update public.profiles set agb_accepted_at = now() where id = v_uid and agb_accepted_at is null;
end;
$$;

revoke all on function public.accept_agb() from public, anon;
grant execute on function public.accept_agb() to authenticated;
