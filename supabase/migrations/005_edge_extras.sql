-- Zusatzspalten für den Brute-Force-Schutz von reset-with-recovery
alter table public.profile_secrets
  add column if not exists recovery_failed int not null default 0,
  add column if not exists recovery_locked_until timestamptz;
