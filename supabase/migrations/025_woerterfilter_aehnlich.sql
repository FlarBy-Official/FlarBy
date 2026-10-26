-- 025: Wörter-Filter strenger: Umlaute/Zahlen-Tricks, Leerzeichen zwischen Buchstaben und 80 % Ähnlichkeit. Idempotent.
create extension if not exists fuzzystrmatch with schema extensions;

-- Kleinschreiben, ä→a, ö→o, ü→u, ß→ss, Zahlentricks (0→o, 1→i, 3→e, 4→a, 5→s, 7→t, @→a, $→s)
create or replace function public._norm_text(p_text text)
returns text language sql immutable set search_path = public, extensions as $$
  select translate(replace(
    regexp_replace(regexp_replace(lower(coalesce(p_text, '')), '!(?=[[:alnum:]])', 'i', 'g'), '\?(?=[[:alnum:]])', 's', 'g'),
    'ß', 'ss'), 'äöü0134@5$7', 'aouoieaasst');
$$;

create or replace function public._check_banned_words()
returns trigger language plpgsql security definer set search_path = public, extensions as $$
declare
  v_body text;
  v_flat text;
  v_tokens text[];
  v_w text;
  v_t text;
begin
  if new.body is null or new.body = '' then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.body is not distinct from old.body then
    return new;
  end if;
  if public.global_rank(new.sender_id) >= 3 then
    return new;
  end if;
  if not exists (select 1 from public.banned_words) then
    return new;
  end if;

  v_body := public._norm_text(new.body);
  v_flat := regexp_replace(v_body, '[^a-z]', '', 'g');
  v_tokens := array(select left(t, 60) from regexp_split_to_table(regexp_replace(v_body, '[^a-z0-9]+', ' ', 'g'), ' ') as t where t <> '' limit 400);

  for v_w in select public._norm_text(word) from public.banned_words loop
    v_w := regexp_replace(v_w, '[^a-z0-9]', '', 'g');
    if v_w = '' then
      continue;
    end if;
    -- 1) Buchstaben stehen hintereinander (auch mit Leerzeichen oder Zeichen dazwischen)
    if position(regexp_replace(v_w, '[^a-z]', '', 'g') in v_flat) > 0 and regexp_replace(v_w, '[^a-z]', '', 'g') <> '' then
      raise exception 'Deine Nachricht enthält ein verbotenes Wort.';
    end if;
    -- 2) Ein Wort ist dem verbotenen Wort zu mindestens 80 % ähnlich
    foreach v_t in array v_tokens loop
      if 1.0 - levenshtein(v_t, v_w)::numeric / greatest(char_length(v_t), char_length(v_w)) >= 0.8 then
        raise exception 'Deine Nachricht enthält ein verbotenes Wort.';
      end if;
    end loop;
  end loop;
  return new;
end;
$$;
