-- FlarChat 004: Storage, Realtime, Funktionsrechte

-- ---------- Storage: privater Bucket 'media' ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('media', 'media', false, 10485760, array['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists media_select on storage.objects;
create policy media_select on storage.objects for select to authenticated
  using (bucket_id = 'media' and public.storage_chat_id(name) is not null and public.rls_is_member(public.storage_chat_id(name)));

drop policy if exists media_insert on storage.objects;
create policy media_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'media' and public.storage_chat_id(name) is not null
              and public.rls_can_send(public.storage_chat_id(name), true));

drop policy if exists media_delete on storage.objects;
create policy media_delete on storage.objects for delete to authenticated
  using (bucket_id = 'media' and owner = auth.uid());

-- ---------- Realtime ----------
do $$
declare
  t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  foreach t in array array['messages', 'chat_members', 'chats', 'profiles'] loop
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

alter table public.chat_members replica identity full;
alter table public.messages replica identity full;

-- ---------- Funktionsrechte: nur authenticated (submit_ticket zusätzlich anon) ----------
revoke all on all functions in schema public from public, anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;

grant execute on function
  public.rls_is_member(uuid), public.rls_can_send(uuid, boolean), public.rls_can_see_profile(uuid),
  public.storage_chat_id(text),
  public.create_group(text), public.start_direct(uuid), public.find_users(text), public.leave_chat(uuid),
  public.delete_chat(uuid), public.mark_read(uuid), public.touch_presence(),
  public.update_chat(uuid, text, text), public.remove_member(uuid, uuid), public.set_member_role(uuid, uuid, uuid),
  public.create_role(uuid, text, text, jsonb), public.update_role(uuid, text, text, jsonb), public.delete_role(uuid),
  public.transfer_ownership(uuid, uuid), public.pin_message(uuid, uuid),
  public.edit_message(uuid, text), public.delete_message(uuid),
  public.create_chat_code(uuid, int), public.create_register_code(int), public.redeem_chat_code(text),
  public.revoke_code(uuid), public.list_codes(uuid), public.reactivate_code(uuid),
  public.report_message(uuid, text), public.list_reports(), public.report_context(uuid), public.resolve_report(uuid),
  public.mod_delete_message(uuid), public.warn_user(uuid, text), public.mute_user(uuid, int), public.ban_user(uuid, boolean),
  public.set_global_role(uuid, text), public.set_verified(text, uuid, boolean), public.set_app_setting(text, jsonb),
  public.set_my_team_tag_visible(boolean), public.set_my_verified_visible(boolean),
  public.list_users(), public.list_tickets(), public.close_ticket(uuid), public.submit_ticket(text, text, text),
  public.clear_must_change_password(), public.my_profile(),
  public.admin_pin_status(), public.admin_set_pin(text, text), public.admin_unlock(text),
  public.admin_list_chats(), public.admin_chat_messages(uuid, timestamptz, int), public.admin_audit_log(int)
  to authenticated;

grant execute on function public.submit_ticket(text, text, text) to anon;

grant usage on schema public to anon, authenticated;
