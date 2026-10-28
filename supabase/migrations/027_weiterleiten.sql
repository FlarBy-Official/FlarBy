-- 027: Weitergeleitete Nachrichten (Markierung "Weitergeleitet"). Idempotent.

alter table public.messages add column if not exists forwarded boolean not null default false;
grant insert (forwarded) on public.messages to authenticated;
