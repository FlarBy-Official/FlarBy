-- Admin-Bereich ohne PIN: nur noch der Owner darf lesen. Jeder Zugriff wird weiter protokolliert.
create or replace function public._need_admin_unlocked()
returns uuid language plpgsql stable security definer set search_path = public, extensions as $$
begin
  return public._need_rank(3, 'Nur der Besitzer hat Zugriff auf den Admin-Bereich.');
end;
$$;
