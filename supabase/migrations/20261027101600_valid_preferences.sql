-- Preferences are written from the browser and read by SQL. A bad timezone made
-- private.today() throw for that user, and made the shared nightly jobs throw for
-- everyone. The values are now checked when they are written.

create function private.is_timezone(p_name text)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
begin
  perform pg_catalog.now() at time zone p_name;
  return true;
exception when others then
  return false;
end;
$$;

create function private.valid_preferences(p jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select pg_catalog.jsonb_typeof(p) = 'object'
    and (p ->> 'timezone' is null or private.is_timezone(p ->> 'timezone'))
    and (p ->> 'weekStart' is null or p ->> 'weekStart' in ('0', '1', '2', '3', '4', '5', '6'))
    and (p ->> 'monthStart' is null or (p ->> 'monthStart' ~ '^[0-9]{1,2}$' and (p ->> 'monthStart')::int between 1 and 31))
    and (p ->> 'salaryDay' is null or (p ->> 'salaryDay' ~ '^[0-9]{1,2}$' and (p ->> 'salaryDay')::int between 1 and 31));
$$;
grant execute on function private.is_timezone(text) to authenticated, service_role;
grant execute on function private.valid_preferences(jsonb) to authenticated, service_role;

-- Drops only what is broken. Everything that reads these has a default to fall back on.
update public.profiles
   set preferences = case
     when jsonb_typeof(preferences) = 'object'
       then preferences - 'timezone' - 'weekStart' - 'monthStart' - 'salaryDay'
     else '{}'::jsonb
   end
 where not private.valid_preferences(preferences);

alter table public.profiles
  add constraint profiles_preferences_valid check (private.valid_preferences(preferences));

-- For the nightly jobs: never throws, whatever is stored.
create function private.safe_timezone(p_name text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_name is not null and private.is_timezone(p_name) then p_name
    else 'Asia/Kolkata'
  end;
$$;

-- Meals defaulted to the time in India whoever logged them, which skewed the meal timing
-- chart for anyone elsewhere.
create function private.local_time()
returns time
language sql
stable
security definer
set search_path = ''
as $$
  select (pg_catalog.now() at time zone coalesce(
    (select p.preferences ->> 'timezone' from public.profiles p where p.id = auth.uid()),
    'Asia/Kolkata'
  ))::time;
$$;
grant execute on function private.local_time() to authenticated, service_role;

alter table public.meal_logs alter column logged_time set default private.local_time();
