-- 017: Meldungen ansehen reparieren
-- messages hat seit 009 die Spalte poll_id. report_context muss sie mitliefern.

create or replace function public.report_context(p_report_id uuid)
returns setof public.messages language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public._need_rank(1, 'Nur das Team darf Meldungen bearbeiten.');
  v_r public.reports;
  v_m public.messages;
begin
  select * into v_r from public.reports where id = p_report_id;
  if not found then
    raise exception 'Meldung nicht gefunden.';
  end if;
  select * into v_m from public.messages where id = v_r.message_id;
  perform public._audit('report_context', p_report_id::text, jsonb_build_object('chat_id', v_r.chat_id, 'message_id', v_r.message_id));
  return query
    select x.id, x.chat_id, x.sender_id,
           case when x.deleted_at is not null and x.id = v_m.id then coalesce(d.body, '') else x.body end,
           case when x.deleted_at is not null and x.id = v_m.id then d.media_path else x.media_path end,
           x.reply_to, x.created_at, x.edited_at, x.deleted_at, x.deleted_by, x.poll_id
    from (
      (select * from public.messages where chat_id = v_m.chat_id and created_at < v_m.created_at order by created_at desc limit 5)
      union all
      (select * from public.messages where id = v_m.id)
      union all
      (select * from public.messages where chat_id = v_m.chat_id and created_at > v_m.created_at order by created_at asc limit 5)
    ) x
    left join public.deleted_message_content d on d.message_id = x.id
    order by x.created_at;
end;
$$;
