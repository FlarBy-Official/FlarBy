-- 013: @everyone nur für App-Owner/Admin (wie @rolle)

create or replace function public._check_role_mentions()
returns trigger language plpgsql security definer set search_path = public, extensions as $$
declare
  r record;
  v_name text;
begin
  if new.body is null or position('@' in new.body) = 0 then
    return new;
  end if;
  if public.global_rank(new.sender_id) >= 2 then
    return new;
  end if;
  if lower(new.body) ~ '@everyone([^[:alnum:]_]|$)' then
    raise exception 'Nur Owner und Admins dürfen @everyone benutzen.';
  end if;
  for r in select name from public.chat_roles where chat_id = new.chat_id loop
    v_name := regexp_replace(lower(r.name), '\s+', '', 'g');
    v_name := regexp_replace(v_name, '([.^$*+?(){}|\[\]\\])', '\\\1', 'g');
    if v_name <> '' and lower(new.body) ~ ('@' || v_name || '([^[:alnum:]_]|$)') then
      raise exception 'Nur Owner und Admins dürfen Rollen erwähnen (@rolle).';
    end if;
  end loop;
  return new;
end;
$$;
