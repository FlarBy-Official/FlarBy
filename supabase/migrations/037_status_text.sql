-- 037: Eigener Status-Text (max. 60 Zeichen)
alter table public.profiles add column if not exists status_text text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_status_text_check') then
    alter table public.profiles add constraint profiles_status_text_check
      check (status_text is null or char_length(status_text) <= 60);
  end if;
end $$;

create or replace function public.set_my_status_text(p_text text)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare v text := nullif(btrim(regexp_replace(coalesce(p_text, ''), '[[:cntrl:]]', ' ', 'g')), '');
begin
  if auth.uid() is null then raise exception 'Nicht angemeldet.'; end if;
  if v is not null and char_length(v) > 60 then raise exception 'Der Status-Text darf höchstens 60 Zeichen haben.'; end if;
  update public.profiles set status_text = v where id = auth.uid();
end $$;

revoke all on function public.set_my_status_text(text) from public, anon;
grant execute on function public.set_my_status_text(text) to authenticated;

create or replace view public.profiles_public as
select
  p.id,
  p.username,
  p.display_name,
  p.avatar_url,
  (p.verified and p.verified_visible) as verified,
  case when p.global_role <> 'user' and p.team_tag_visible then p.global_role else null end as team_role,
  p.last_seen,
  case when p.status_until is null or p.status_until > now() then p.status_key else null end as status,
  p.status_text
from public.profiles p;
