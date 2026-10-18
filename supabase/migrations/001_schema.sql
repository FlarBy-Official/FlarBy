-- FlarChat 001: Schema (Tabellen, Indizes, Views)
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique check (username ~ '^[a-z0-9_]{3,20}$'),
  display_name text not null check (char_length(display_name) between 1 and 40),
  avatar_url text,
  global_role text not null default 'user' check (global_role in ('user','moderator','admin','owner')),
  team_tag_visible boolean not null default true,
  verified boolean not null default false,
  verified_visible boolean not null default true,
  muted_until timestamptz,
  banned boolean not null default false,
  must_change_password boolean not null default false,
  last_seen timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.profile_secrets (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  recovery_hash text not null
);

create table if not exists public.chats (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('direct','group')),
  name text check (name is null or char_length(name) between 1 and 50),
  avatar_url text,
  verified boolean not null default false,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  pinned_message_id uuid
);

create table if not exists public.chat_roles (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references public.chats(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 30),
  color text check (color is null or color ~ '^#[0-9A-Fa-f]{6}$'),
  is_system boolean not null default false,
  system_key text check (system_key in ('owner','admin','member')),
  permissions jsonb not null default '{}'::jsonb,
  position int not null default 0
);
create unique index if not exists chat_roles_system_uq on public.chat_roles(chat_id, system_key) where system_key is not null;
create index if not exists chat_roles_chat_idx on public.chat_roles(chat_id);

create table if not exists public.chat_members (
  chat_id uuid not null references public.chats(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role_id uuid references public.chat_roles(id) on delete set null,
  joined_at timestamptz not null default now(),
  last_read_at timestamptz not null default now(),
  primary key (chat_id, user_id)
);
create index if not exists chat_members_user_idx on public.chat_members(user_id);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references public.chats(id) on delete cascade,
  sender_id uuid not null references public.profiles(id) on delete cascade,
  body text not null default '' check (char_length(body) <= 4000),
  media_path text,
  reply_to uuid references public.messages(id) on delete set null,
  created_at timestamptz not null default now(),
  edited_at timestamptz,
  deleted_at timestamptz,
  deleted_by uuid references public.profiles(id) on delete set null,
  check (deleted_at is not null or body <> '' or media_path is not null)
);
create index if not exists messages_chat_created_idx on public.messages(chat_id, created_at desc);
create index if not exists messages_sender_idx on public.messages(sender_id);

alter table public.chats drop constraint if exists chats_pinned_message_fk;
alter table public.chats add constraint chats_pinned_message_fk
  foreign key (pinned_message_id) references public.messages(id) on delete set null;

-- Originalinhalt gelöschter Nachrichten (nur Admin-Bereich / gemeldete Nachrichten); keine Policies
create table if not exists public.deleted_message_content (
  message_id uuid primary key references public.messages(id) on delete cascade,
  body text not null default '',
  media_path text
);

create table if not exists public.message_edits (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.messages(id) on delete cascade,
  old_body text not null,
  edited_at timestamptz not null default now()
);
create index if not exists message_edits_msg_idx on public.message_edits(message_id);

create table if not exists public.reports (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.messages(id) on delete cascade,
  chat_id uuid not null references public.chats(id) on delete cascade,
  reporter_id uuid not null references public.profiles(id) on delete cascade,
  reason text not null check (char_length(reason) between 1 and 500),
  status text not null default 'open' check (status in ('open','resolved')),
  handled_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists reports_status_idx on public.reports(status, created_at desc);
create index if not exists reports_message_idx on public.reports(message_id);

create table if not exists public.invite_codes (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[0-9]{12}$'),
  kind text not null check (kind in ('chat','register')),
  chat_id uuid references public.chats(id) on delete cascade,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_by uuid references public.profiles(id) on delete set null,
  used_at timestamptz,
  revoked boolean not null default false,
  check (kind <> 'chat' or chat_id is not null)
);
create index if not exists invite_codes_chat_idx on public.invite_codes(chat_id);

create table if not exists public.tickets (
  id uuid primary key default gen_random_uuid(),
  username text not null,
  message text not null check (char_length(message) between 1 and 1000),
  device_id text not null,
  status text not null default 'open' check (status in ('open','done')),
  created_at timestamptz not null default now(),
  handled_by uuid references public.profiles(id) on delete set null,
  handled_at timestamptz
);
create index if not exists tickets_device_idx on public.tickets(device_id, created_at desc);
create index if not exists tickets_username_idx on public.tickets(username, created_at desc);

create table if not exists public.warnings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  by_user uuid references public.profiles(id) on delete set null,
  reason text not null,
  created_at timestamptz not null default now()
);
create index if not exists warnings_user_idx on public.warnings(user_id);

create table if not exists public.audit_log (
  id bigint generated always as identity primary key,
  actor_id uuid references public.profiles(id) on delete set null,
  action text not null,
  target text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists audit_log_created_idx on public.audit_log(created_at desc);

create table if not exists public.admin_pins (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  pin_hash text not null,
  failed_attempts int not null default 0,
  locked_until timestamptz,
  unlocked_until timestamptz
);

create table if not exists public.app_settings (
  key text primary key,
  value jsonb not null
);
insert into public.app_settings(key, value) values ('group_creation_restricted', 'false'::jsonb)
  on conflict (key) do nothing;

-- Öffentliche Profilsicht (Besitzer-Rechte: umgeht RLS bewusst, zeigt nur unkritische Spalten)
create or replace view public.profiles_public as
select
  p.id,
  p.username,
  p.display_name,
  p.avatar_url,
  (p.verified and p.verified_visible) as verified,
  case when p.global_role <> 'user' and p.team_tag_visible then p.global_role else null end as team_role,
  p.last_seen
from public.profiles p;

-- Chatliste des angemeldeten Nutzers
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
  peer.id as peer_user_id
from public.chat_members me
join public.chats c on c.id = me.chat_id
left join lateral (
  select p.id, p.display_name, p.avatar_url
  from public.chat_members cm join public.profiles p on p.id = cm.user_id
  where c.type = 'direct' and cm.chat_id = c.id and cm.user_id <> me.user_id
  limit 1
) peer on true
left join lateral (
  select case when m.deleted_at is null then m.body else null end as body, m.created_at, m.sender_id
  from public.messages m
  where m.chat_id = c.id
  order by m.created_at desc
  limit 1
) lm on true
where me.user_id = auth.uid();
