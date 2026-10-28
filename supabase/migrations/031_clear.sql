-- 031: /clear löscht alle Nachrichten eines Chats für immer. Idempotent.
-- Erlaubt: Admins und Owner (in jedem Chat) sowie der Besitzer einer Gruppe.

create or replace function public.clear_chat(p_chat_id uuid)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._me();
  v_type text;
  v_n int;
begin
  select type into v_type from public.chats where id = p_chat_id;
  if v_type is null or not public.is_chat_member(p_chat_id, v_uid) then
    raise exception 'Chat nicht gefunden.';
  end if;
  if not (
    exists (select 1 from public.profiles where id = v_uid and global_role in ('admin', 'owner'))
    or (v_type = 'group' and public.has_chat_perm(p_chat_id, v_uid, 'delete_chat'))
  ) then
    raise exception 'Nur der Besitzer der Gruppe, Admins und der Owner dürfen den Chat leeren.';
  end if;

  update public.chats set pinned_message_id = null where id = p_chat_id;

  -- Bilder und Sprachnachrichten mit löschen (falls der Speicher das zulässt)
  begin
    delete from storage.objects
     where bucket_id = 'media'
       and name in (select media_path from public.messages where chat_id = p_chat_id and media_path is not null);
  exception when others then
    null;
  end;

  delete from public.messages where chat_id = p_chat_id;
  get diagnostics v_n = row_count;

  perform public._audit('chat_clear', p_chat_id::text, jsonb_build_object('messages', v_n));
end;
$$;

revoke all on function public.clear_chat(uuid) from public, anon, authenticated;
grant execute on function public.clear_chat(uuid) to authenticated;
