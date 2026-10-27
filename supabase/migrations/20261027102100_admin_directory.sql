-- The admin panel paged through the auth API for every screen, and that listing silently
-- stopped at 1,000 users. This reads only what the screen needs, in one query.
create function public.admin_user_directory(p_ids uuid[] default null)
returns table (
  id uuid,
  email text,
  confirmed boolean,
  last_sign_in timestamptz,
  created_at timestamptz,
  display_name text,
  role text,
  onboarded_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    u.id,
    coalesce(u.email, '')::text,
    u.email_confirmed_at is not null,
    u.last_sign_in_at,
    u.created_at,
    p.display_name,
    p.role,
    p.onboarded_at
  from auth.users u
  join public.profiles p on p.id = u.id
  where p_ids is null or u.id = any (p_ids)
  order by u.created_at desc;
$$;

revoke execute on function public.admin_user_directory(uuid[]) from public, anon, authenticated;
grant execute on function public.admin_user_directory(uuid[]) to service_role;
