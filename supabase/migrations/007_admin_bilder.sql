-- Der Owner darf alle Bilder im Admin-Panel ansehen (nur Lesen).
create or replace function public.rls_is_owner()
returns boolean language sql stable security definer set search_path = public as $$
select exists (select 1 from public.profiles where id = auth.uid() and global_role = 'owner');
$$;

drop policy if exists media_select_owner on storage.objects;
create policy media_select_owner on storage.objects for select to authenticated
                                                                 using (bucket_id = 'media' and public.rls_is_owner());
