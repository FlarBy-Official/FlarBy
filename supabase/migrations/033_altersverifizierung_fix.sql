-- 033: Fix zu 032. Die Chatliste (View) wird mit den Rechten des Nutzers geprüft:
-- Funktionen darin braucht der Nutzer als EXECUTE-Recht. Darum eine Funktion ohne Parameter, die nur für den
-- eigenen Nutzer antwortet. Idempotent.

create or replace function public._age_ok_me()
returns boolean language sql stable security definer set search_path = public, extensions as $$
select public._age_ok(auth.uid());
$$;

revoke all on function public._age_ok_me() from public, anon;
grant execute on function public._age_ok_me() to authenticated;

create or replace view public.chat_overview as
select
  c.id as chat_id,
  case when c.type = 'direct' then peer.display_name else c.name end as name,
  c.type,
  case when c.type = 'direct' then peer.avatar_url else c.avatar_url end as avatar_url,
  c.verified,
  lm.body as last_message_body,
  lm.created_at as last_message_at,
  lm.sender_id as last_message_sender,
  (select count(*)::int from public.messages m
    where m.chat_id = c.id and m.deleted_at is null
      and m.sender_id <> me.user_id and m.created_at > me.last_read_at) as unread_count,
  me.role_id as my_role_id,
  peer.id as peer_user_id,
  lm.is_system as last_message_is_system,
  case when c.type = 'ticket' then case when c.closed_at is null then 'open' else 'closed' end end as ticket_status
from public.chat_members me
join public.chats c on c.id = me.chat_id
left join lateral (
  select p.id, p.display_name, p.avatar_url
  from public.chat_members cm join public.profiles p on p.id = cm.user_id
  where c.type = 'direct' and cm.chat_id = c.id and cm.user_id <> me.user_id
  limit 1
) peer on true
left join lateral (
  select case when m.deleted_at is null then m.body else null end as body, m.created_at, m.sender_id, m.is_system
  from public.messages m
  where m.chat_id = c.id
  order by m.created_at desc
  limit 1
) lm on true
where me.user_id = auth.uid() and public._age_ok_me();

grant select on public.chat_overview to authenticated;
