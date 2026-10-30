-- 036: Konto "bela_owner" dauerhaft schützen: immer Owner, nie gesperrt, nie stumm, Alter immer geprüft.
-- Einmal im SQL Editor ausführen. Idempotent.

update public.profiles
   set global_role = 'owner', banned = false, muted_until = null, verified = true, must_change_password = false
 where username = 'bela_owner';

insert into public.age_records(user_id, verified, verified_at)
select id, true, now() from public.profiles where username = 'bela_owner'
on conflict (user_id) do update set verified = true, too_young = false, verified_at = coalesce(public.age_records.verified_at, now());

create or replace function public._protect_bela_owner()
returns trigger language plpgsql as $$
begin
  if new.username = 'bela_owner' then
    new.global_role := 'owner';
    new.banned := false;
    new.muted_until := null;
  end if;
  return new;
end;
$$;

drop trigger if exists protect_bela_owner on public.profiles;
create trigger protect_bela_owner
  before update on public.profiles
  for each row execute function public._protect_bela_owner();

create or replace function public._protect_bela_owner_age()
returns trigger language plpgsql as $$
begin
  if new.user_id = (select id from public.profiles where username = 'bela_owner') then
    new.verified := true;
    new.too_young := false;
  end if;
  return new;
end;
$$;

drop trigger if exists protect_bela_owner_age on public.age_records;
create trigger protect_bela_owner_age
  before insert or update on public.age_records
  for each row execute function public._protect_bela_owner_age();
