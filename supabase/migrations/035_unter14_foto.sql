-- 035: Auch das Foto von Nutzern unter 14 wird gespeichert, damit das Team es ansehen kann.
-- Es gibt dann einen abgelehnten Antrag mit Foto (kommt nicht in die Warteschlange). Idempotent.

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
    raise exception 'Bitte stimme den AGB zu.';
  end if;
  if p_method not in ('ausweis', 'buerge') then
    raise exception 'Unbekannte Methode.';
  end if;
  if exists (select 1 from public.age_requests where user_id = v_uid and status in ('guardian_wait', 'open', 'mod_ok', 'mod_no')) then
    raise exception 'Du hast schon eine offene Prüfung.';
  end if;

  select * into v_rec from public.age_records where user_id = v_uid;
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
    -- Foto trotzdem sichern (abgelehnter Antrag), damit das Team es sehen kann
    if p_method = 'ausweis' and p_photo is not null
       and p_photo ~ '^data:image/jpeg;base64,[A-Za-z0-9+/=]+$' and char_length(p_photo) >= 2000 then
      insert into public.age_requests(user_id, method, status, reject_reason, final_at, consent_at)
      values (v_uid, 'ausweis', 'rejected', 'Unter 14', now(), now())
      returning id into v_req;
      insert into public.age_photos(request_id, user_id, data) values (v_req, v_uid, p_photo);
    end if;
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

revoke all on function public.age_submit(date, text, text, text, boolean) from public, anon;
grant execute on function public.age_submit(date, text, text, text, boolean) to authenticated;
