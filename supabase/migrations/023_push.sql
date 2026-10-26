-- 023: Handy-Push-Mitteilungen (Web Push). Idempotent.
-- Das geheime Wort wird NICHT hier gespeichert. Es kommt per docs/PUSH.md in die Tabelle push_config.

create extension if not exists pg_net;
create extension if not exists pg_cron;

-- ---------- Tabellen ----------
create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now()
);
create index if not exists push_subscriptions_user_idx on public.push_subscriptions(user_id);

create table if not exists public.push_prefs (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  show_text boolean not null default false
);

create table if not exists public.push_muted_chats (
  user_id uuid not null references public.profiles(id) on delete cascade,
  chat_id uuid not null references public.chats(id) on delete cascade,
  primary key (user_id, chat_id)
);

-- Einstellungen für den Server (z. B. das geheime Wort). Keine Policies: nur security definer / service role.
create table if not exists public.push_config (
  key text primary key,
  value text not null
);

alter table public.push_subscriptions enable row level security;
alter table public.push_prefs enable row level security;
alter table public.push_muted_chats enable row level security;
alter table public.push_config enable row level security;
revoke all on public.push_subscriptions, public.push_prefs, public.push_muted_chats, public.push_config from anon, authenticated;

-- ---------- RPC ----------
create or replace function public.save_push_subscription(p_endpoint text, p_p256dh text, p_auth text, p_user_agent text default null)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._me();
begin
  if coalesce(p_endpoint, '') = '' or coalesce(p_p256dh, '') = '' or coalesce(p_auth, '') = '' then
    raise exception 'Ungültiges Mitteilungs-Abo.';
  end if;
  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
  values (v_uid, p_endpoint, p_p256dh, p_auth, left(p_user_agent, 300))
  on conflict (endpoint) do update
    set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent;
end;
$$;

create or replace function public.remove_push_subscription(p_endpoint text)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._me();
begin
  delete from public.push_subscriptions where endpoint = p_endpoint and user_id = v_uid;
end;
$$;

create or replace function public.set_push_show_text(p_value boolean)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._me();
begin
  insert into public.push_prefs (user_id, show_text) values (v_uid, coalesce(p_value, false))
  on conflict (user_id) do update set show_text = excluded.show_text;
end;
$$;

create or replace function public.get_push_prefs()
returns table (show_text boolean) language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._me();
begin
  return query select coalesce((select pp.show_text from public.push_prefs pp where pp.user_id = v_uid), false);
end;
$$;

create or replace function public.set_chat_muted_server(p_chat_id uuid, p_muted boolean)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._me();
begin
  if p_muted then
    if exists (select 1 from public.chat_members where chat_id = p_chat_id and user_id = v_uid) then
      insert into public.push_muted_chats (user_id, chat_id) values (v_uid, p_chat_id) on conflict do nothing;
    end if;
  else
    delete from public.push_muted_chats where user_id = v_uid and chat_id = p_chat_id;
  end if;
end;
$$;

-- Lädt alle lokal stummen Chats hoch (nur hinzufügen, nie löschen)
create or replace function public.sync_muted_chats(p_chat_ids uuid[])
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._me();
begin
  insert into public.push_muted_chats (user_id, chat_id)
  select v_uid, cm.chat_id from public.chat_members cm
  where cm.user_id = v_uid and cm.chat_id = any(coalesce(p_chat_ids, '{}'::uuid[]))
  on conflict do nothing;
end;
$$;

-- ---------- Aufruf der Edge Function (nur intern) ----------
create or replace function public._push_call(p_body jsonb)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_secret text;
begin
  select value into v_secret from public.push_config where key = 'webhook_secret';
  if v_secret is null or v_secret = '' then
    return; -- noch nicht eingerichtet
  end if;
  perform net.http_post(
    url := 'https://vrofsgvzjjjrltixjaqd.supabase.co/functions/v1/send-push',
    body := p_body,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', v_secret)
  );
end;
$$;

create or replace function public._push_on_message()
returns trigger language plpgsql security definer set search_path = public, extensions as $$
begin
  begin
    perform public._push_call(jsonb_build_object('type', 'message', 'message_id', new.id));
  exception when others then
    null; -- Eine Nachricht darf nie wegen Push scheitern
  end;
  return new;
end;
$$;

drop trigger if exists push_on_message on public.messages;
create trigger push_on_message after insert on public.messages
  for each row execute function public._push_on_message();

-- Jede Minute Erinnerungen prüfen
do $$
begin
  perform cron.unschedule('flarchat-push-reminders');
exception when others then null;
end $$;
do $$
begin
  perform cron.schedule('flarchat-push-reminders', '* * * * *', $cron$select public._push_call('{"type":"reminders"}'::jsonb)$cron$);
exception when others then
  raise notice 'pg_cron konnte nicht eingerichtet werden: %', sqlerrm;
end $$;

-- ---------- Rechte ----------
revoke all on function public._push_call(jsonb), public._push_on_message() from public, anon, authenticated;
revoke all on function public.save_push_subscription(text, text, text, text), public.remove_push_subscription(text),
  public.set_push_show_text(boolean), public.get_push_prefs(), public.set_chat_muted_server(uuid, boolean),
  public.sync_muted_chats(uuid[]) from public, anon;
grant execute on function
  public.save_push_subscription(text, text, text, text), public.remove_push_subscription(text),
  public.set_push_show_text(boolean), public.get_push_prefs(), public.set_chat_muted_server(uuid, boolean),
  public.sync_muted_chats(uuid[])
  to authenticated;
