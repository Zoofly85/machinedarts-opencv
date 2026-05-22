alter table public.throws
  add column if not exists fronton_image_url text,
  add column if not exists fronton_image_path text;

comment on column public.throws.fronton_image_url is
  'Public URL for the lightweight fronton snapshot shown to the remote opponent.';
comment on column public.throws.fronton_image_path is
  'Storage object path for the fronton snapshot, used for overwrites and cleanup.';

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'online-fronton',
  'online-fronton',
  true,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'Online fronton public read'
  ) then
    create policy "Online fronton public read"
      on storage.objects
      for select
      using (bucket_id = 'online-fronton');
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'Online fronton authenticated upload'
  ) then
    create policy "Online fronton authenticated upload"
      on storage.objects
      for insert
      to authenticated
      with check (bucket_id = 'online-fronton');
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'Online fronton authenticated update'
  ) then
    create policy "Online fronton authenticated update"
      on storage.objects
      for update
      to authenticated
      using (bucket_id = 'online-fronton')
      with check (bucket_id = 'online-fronton');
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'Online fronton authenticated delete'
  ) then
    create policy "Online fronton authenticated delete"
      on storage.objects
      for delete
      to authenticated
      using (bucket_id = 'online-fronton');
  end if;
end
$$;
