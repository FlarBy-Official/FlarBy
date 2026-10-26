-- Status für Nutzer (idempotent)
alter table public.profiles add column if not exists status_key text;
alter table public.profiles add column if not exists status_until timestamptz;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_status_key_check') then
    alter table public.profiles add constraint profiles_status_key_check
      check (status_key is null or status_key in ('online','sleep','dnd','school'));
  end if;
end $$;

create or replace function public.set_my_status(p_key text, p_until timestamptz)
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  if auth.uid() is null then raise exception 'Nicht angemeldet.'; end if;
  if p_key is null then
    update public.profiles set status_key = null, status_until = null where id = auth.uid();
    return;
  end if;
  if p_key not in ('online','sleep','dnd','school') then raise exception 'Ungültiger Status.'; end if;
  update public.profiles set status_key = p_key, status_until = p_until where id = auth.uid();
end $$;

revoke all on function public.set_my_status(text, timestamptz) from public, anon;
grant execute on function public.set_my_status(text, timestamptz) to authenticated;

create or replace view public.profiles_public as
select
  p.id,
  p.username,
  p.display_name,
  p.avatar_url,
  (p.verified and p.verified_visible) as verified,
  case when p.global_role <> 'user' and p.team_tag_visible then p.global_role else null end as team_role,
  p.last_seen,
  case when p.status_until is null or p.status_until > now() then p.status_key else null end as status
from public.profiles p;
