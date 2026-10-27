-- These helpers run for every table a query touches. Written with a bare auth.uid() or
-- auth.jwt(), the JSON claims were parsed again for each row compared, so on a small
-- table, where Postgres prefers a sequential scan, the cost grew with every user and
-- every open session. As subqueries they are read once.

create or replace function private.gate_ok()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.gate_sessions s
    where s.session_id = (select nullif(auth.jwt() ->> 'session_id', '')::uuid)
      and s.user_id = (select auth.uid())
      and s.expires_at > now()
  );
$$;

create or replace function private.today()
returns date
language sql
stable
security definer
set search_path = ''
as $$
  select (now() at time zone coalesce(
    (select p.preferences ->> 'timezone' from public.profiles p where p.id = (select auth.uid())),
    'Asia/Kolkata'
  ))::date;
$$;

create or replace function private.local_time()
returns time
language sql
stable
security definer
set search_path = ''
as $$
  select (now() at time zone coalesce(
    (select p.preferences ->> 'timezone' from public.profiles p where p.id = (select auth.uid())),
    'Asia/Kolkata'
  ))::time;
$$;

create or replace function private.preference_int(key text, fallback int)
returns int
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select (p.preferences ->> key)::int from public.profiles p where p.id = (select auth.uid())),
    fallback
  );
$$;
