-- 015: Alle App-Owner sind automatisch verifiziert (blauer Haken)
-- Der Owner kann den Haken weiter in den Einstellungen ausblenden (verified_visible).

create or replace function public._owner_verified()
returns trigger language plpgsql security definer set search_path = public, extensions as $$
begin
  if new.global_role = 'owner' then
    new.verified := true;
  end if;
  return new;
end;
$$;

drop trigger if exists owner_verified on public.profiles;
create trigger owner_verified before insert or update on public.profiles
  for each row execute function public._owner_verified();

update public.profiles set verified = true where global_role = 'owner' and verified = false;
