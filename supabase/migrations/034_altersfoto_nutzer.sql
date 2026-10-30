-- 034: Foto eines Nutzers ansehen (neuestes Foto), für Admin und Owner. Jeder Blick kommt ins Protokoll. Idempotent.

create or replace function public.age_photo_user(p_user uuid)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._need_rank(2, 'Nur Admins und der Owner dürfen Fotos ansehen.');
  v_data text;
  v_req uuid;
begin
  select ph.data, ph.request_id into v_data, v_req
  from public.age_photos ph where ph.user_id = p_user
  order by ph.created_at desc limit 1;
  if v_data is null then
    return null;
  end if;
  if p_user = v_uid then
    raise exception 'Du darfst dein eigenes Foto nicht ansehen.';
  end if;
  perform public._audit('age_view_photo', p_user::text, jsonb_build_object('request', v_req));
  return v_data;
end;
$$;

revoke all on function public.age_photo_user(uuid) from public, anon;
grant execute on function public.age_photo_user(uuid) to authenticated;
