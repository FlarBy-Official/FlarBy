-- 029: Owner kann die AGB-Zustimmung erneut anfordern. Idempotent.
-- Liegt in app_settings (key 'agb_required_at'). Wer vorher zugestimmt hat, muss beim nächsten Einloggen neu zustimmen.

create or replace function public.admin_require_agb_again()
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._need_admin_unlocked();
begin
  insert into public.app_settings(key, value)
  values ('agb_required_at', jsonb_build_object('at', now()))
  on conflict (key) do update set value = excluded.value;
  perform public._audit('admin_agb_again', null, '{}'::jsonb);
end;
$$;

-- Zustimmung immer neu setzen (vorher nur beim ersten Mal)
create or replace function public.accept_agb()
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._me();
begin
  update public.profiles set agb_accepted_at = now() where id = v_uid;
end;
$$;

revoke all on function public.admin_require_agb_again() from public, anon;
grant execute on function public.admin_require_agb_again() to authenticated;
revoke all on function public.accept_agb() from public, anon;
grant execute on function public.accept_agb() to authenticated;
