-- FlarChat 002: Helper + Row Level Security (restriktiv)

-- ---------- Helper ----------
create or replace function public.global_rank(p_user uuid)
returns int language sql stable security definer set search_path = public, extensions as $$
select coalesce((select case global_role when 'owner' then 3 when 'admin' then 2 when 'moderator' then 1 else 0 end
                 from public.profiles where id = p_user), 0);
$$;

create or replace function public.is_chat_member(p_chat uuid, p_user uuid)
returns boolean language sql stable security definer set search_path = public, extensions as $$
select exists (select 1 from public.chat_members where chat_id = p_chat and user_id = p_user);
$$;

create or replace function public.has_chat_perm(p_chat uuid, p_user uuid, p_perm text)
returns boolean language plpgsql stable security definer set search_path = public, extensions as $$
declare
v_type text;
  v_role public.chat_roles;
begin
select type into v_type from public.chats where id = p_chat;
if v_type is null or not public.is_chat_member(p_chat, p_user) then
    return false;
end if;
  if v_type = 'direct' then
    return p_perm in ('send_messages', 'send_media');
end if;
select r.* into v_role from public.chat_members m
                                join public.chat_roles r on r.id = m.role_id
where m.chat_id = p_chat and m.user_id = p_user;
if not found then
    return false;
end if;
  if v_role.system_key = 'owner' then
    return true;
end if;
return coalesce((v_role.permissions ->> p_perm)::boolean, false);
end;
$$;

-- Nur für RLS (immer auth.uid()): Mitgliedschaft
create or replace function public.rls_is_member(p_chat uuid)
returns boolean language sql stable security definer set search_path = public, extensions as $$
select public.is_chat_member(p_chat, auth.uid())
           and not exists (select 1 from public.profiles where id = auth.uid() and banned);
$$;

-- Nur für RLS: darf der Nutzer jetzt in diesem Chat senden? (Mitglied, Recht, nicht gebannt, nicht stumm)
create or replace function public.rls_can_send(p_chat uuid, p_media boolean)
returns boolean language sql stable security definer set search_path = public, extensions as $$
select auth.uid() is not null
           and exists (select 1 from public.profiles p
                       where p.id = auth.uid() and not p.banned
                         and (p.muted_until is null or p.muted_until <= now()))
           and public.has_chat_perm(p_chat, auth.uid(), 'send_messages')
           and (not p_media or public.has_chat_perm(p_chat, auth.uid(), 'send_media'));
$$;

-- Nur für RLS: teilt der Nutzer einen Chat mit p_user (oder ist Moderator+)?
create or replace function public.rls_can_see_profile(p_user uuid)
returns boolean language sql stable security definer set search_path = public, extensions as $$
select auth.uid() is not null and (
    p_user = auth.uid()
        or public.global_rank(auth.uid()) >= 1
        or exists (select 1 from public.chat_members a join public.chat_members b on a.chat_id = b.chat_id
                   where a.user_id = auth.uid() and b.user_id = p_user)
    );
$$;

-- Sichere Umwandlung eines Storage-Pfads in eine Chat-ID (null bei Fehler)
create or replace function public.storage_chat_id(p_name text)
returns uuid language sql immutable set search_path = public, extensions as $$
select case when split_part(p_name, '/', 1) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              then split_part(p_name, '/', 1)::uuid else null end;
$$;

-- ---------- Rechte auf Tabellen zurücksetzen ----------
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

grant select on public.profiles, public.chats, public.chat_roles, public.chat_members, public.messages,
    public.app_settings to authenticated;
grant select on public.profiles_public, public.chat_overview to authenticated;
grant update (display_name, avatar_url) on public.profiles to authenticated;
grant insert (chat_id, sender_id, body, media_path, reply_to) on public.messages to authenticated;

-- ---------- RLS auf ALLEN Tabellen ----------
alter table public.profiles enable row level security;
alter table public.profile_secrets enable row level security;
alter table public.chats enable row level security;
alter table public.chat_roles enable row level security;
alter table public.chat_members enable row level security;
alter table public.messages enable row level security;
alter table public.deleted_message_content enable row level security;
alter table public.message_edits enable row level security;
alter table public.reports enable row level security;
alter table public.invite_codes enable row level security;
alter table public.tickets enable row level security;
alter table public.warnings enable row level security;
alter table public.audit_log enable row level security;
alter table public.admin_pins enable row level security;
alter table public.app_settings enable row level security;

-- Ohne Policies (nur service role / security definer): profile_secrets, admin_pins, deleted_message_content,
-- message_edits, reports, invite_codes, tickets, warnings, audit_log

drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
                                                              using (public.rls_can_see_profile(id));

drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles for update to authenticated
                                                                   using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists chats_select on public.chats;
create policy chats_select on public.chats for select to authenticated
                                                        using (public.rls_is_member(id));

drop policy if exists chat_roles_select on public.chat_roles;
create policy chat_roles_select on public.chat_roles for select to authenticated
                                                                  using (public.rls_is_member(chat_id));

drop policy if exists chat_members_select on public.chat_members;
create policy chat_members_select on public.chat_members for select to authenticated
                                                                      using (public.rls_is_member(chat_id));

drop policy if exists messages_select on public.messages;
create policy messages_select on public.messages for select to authenticated
                                                              using (public.rls_is_member(chat_id));

drop policy if exists messages_insert on public.messages;
create policy messages_insert on public.messages for insert to authenticated
  with check (
    sender_id = auth.uid()
    and public.rls_can_send(chat_id, media_path is not null)
    and (media_path is null or media_path like chat_id::text || '/%')
    and (reply_to is null or exists (select 1 from public.messages r where r.id = reply_to and r.chat_id = messages.chat_id))
  );

drop policy if exists app_settings_select on public.app_settings;
create policy app_settings_select on public.app_settings for select to authenticated
                                                                                  using (true);
