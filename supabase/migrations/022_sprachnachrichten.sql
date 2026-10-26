-- FlarChat 022: Sprachnachrichten
-- Sprachnachrichten liegen im Bucket 'media' unter <chat_id>/<uuid>.webm|m4a|ogg.
-- Erkannt werden sie an der Dateiendung von messages.media_path. messages bekommt KEINE neue Spalte.

update storage.buckets
   set file_size_limit = 10485760,
       allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'image/gif',
                                  'audio/webm', 'audio/mp4', 'audio/ogg', 'audio/x-m4a']
 where id = 'media';

-- Das Team darf Medien aus Meldungen ansehen und anhören.
drop policy if exists media_select_team on storage.objects;
create policy media_select_team on storage.objects for select to authenticated
  using (bucket_id = 'media' and public.rls_is_team());
