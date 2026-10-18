-- Emoji-Reaktionen: pro Person und Nachricht genau eine Reaktion.
create table if not exists public.message_reactions (
  message_id uuid not null references public.messages(id) on delete cascade,
  chat_id uuid not null references public.chats(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  emoji text not null check (emoji in ('👍', '❤️', '😂', '😮', '😢', '🙏')),
  created_at timestamptz not null default now(),
  primary key (message_id, user_id)
);
create index if not exists message_reactions_chat_idx on public.message_reactions(chat_id);

alter table public.message_reactions enable row level security;
drop policy if exists message_reactions_select on public.message_reactions;
create policy message_reactions_select on public.message_reactions for select to authenticated
  using (public.rls_is_member(chat_id));

revoke all on public.message_reactions from anon, authenticated;
grant select on public.message_reactions to authenticated;

-- Gleiche Reaktion nochmal = entfernen. Andere Reaktion = ersetzen. null = entfernen.
create or replace function public.react_message(p_message_id uuid, p_emoji text)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._me();
  v_chat uuid;
  v_old text;
begin
  select chat_id into v_chat from public.messages where id = p_message_id and deleted_at is null;
  if v_chat is null or not public.is_chat_member(v_chat, v_uid) then
    raise exception 'Nachricht nicht gefunden.';
  end if;
  select emoji into v_old from public.message_reactions where message_id = p_message_id and user_id = v_uid;
  if p_emoji is null or p_emoji = v_old then
    delete from public.message_reactions where message_id = p_message_id and user_id = v_uid;
    return;
  end if;
  if not public.rls_can_send(v_chat, false) then
    raise exception 'Du darfst gerade nicht reagieren.';
  end if;
  insert into public.message_reactions(message_id, chat_id, user_id, emoji)
    values (p_message_id, v_chat, v_uid, p_emoji)
    on conflict (message_id, user_id) do update set emoji = excluded.emoji, created_at = now();
end;
$$;

revoke all on function public.react_message(uuid, text) from public, anon, authenticated;
grant execute on function public.react_message(uuid, text) to authenticated;

alter table public.message_reactions replica identity full;
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'message_reactions') then
    alter publication supabase_realtime add table public.message_reactions;
  end if;
end $$;
