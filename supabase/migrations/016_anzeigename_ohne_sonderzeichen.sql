-- 016: Anzeigenamen dürfen keine Sonderzeichen haben (kein ! ? [] {} () usw.)
-- Erlaubt: Buchstaben, Zahlen, Leerzeichen, _ - .
-- Bestehende Namen bleiben, nur neue Änderungen werden geprüft.

create or replace function public._check_display_name()
returns trigger language plpgsql security definer set search_path = public, extensions as $$
begin
  if tg_op = 'UPDATE' and new.display_name is not distinct from old.display_name then
    return new;
  end if;
  if new.display_name !~ '^[[:alnum:] _.-]+$' then
    raise exception 'Keine Sonderzeichen im Namen erlaubt. Nur Buchstaben, Zahlen, Leerzeichen und _ - .';
  end if;
  return new;
end;
$$;

drop trigger if exists check_display_name on public.profiles;
create trigger check_display_name before insert or update of display_name on public.profiles
  for each row execute function public._check_display_name();
