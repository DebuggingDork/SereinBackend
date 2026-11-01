-- Salaries rarely land on a fixed date. A person can now say "the last working day of the
-- month" and name the account it reaches. Weekends are skipped; public holidays are not known.

create function private.is_uuid(value text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
$$;
grant execute on function private.is_uuid(text) to authenticated, service_role;

create or replace function private.valid_preferences(p jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select pg_catalog.jsonb_typeof(p) = 'object'
    and (p ->> 'timezone' is null or private.is_timezone(p ->> 'timezone'))
    and (p ->> 'weekStart' is null or p ->> 'weekStart' in ('0', '1', '2', '3', '4', '5', '6'))
    and (p ->> 'monthStart' is null or (p ->> 'monthStart' ~ '^[0-9]{1,2}$' and (p ->> 'monthStart')::int between 1 and 31))
    and (p ->> 'salaryDay' is null or (p ->> 'salaryDay' ~ '^[0-9]{1,2}$' and (p ->> 'salaryDay')::int between 1 and 31))
    and (p ->> 'salaryRule' is null or p ->> 'salaryRule' in ('date', 'last_working_day', 'last_day', 'first_working_day'))
    and (p ->> 'salaryAccountId' is null or private.is_uuid(p ->> 'salaryAccountId'));
$$;

create function private.preference_text(key text, fallback text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select p.preferences ->> key from public.profiles p where p.id = auth.uid()),
    fallback
  );
$$;
grant execute on function private.preference_text(text, text) to authenticated;

-- The day a salary lands in the month holding p_month. A date past the end of a short month
-- becomes that month's last day.
create function private.salary_date_in(p_rule text, p_day int, p_month date)
returns date
language sql
immutable
set search_path = ''
as $$
  with m as (
    select pg_catalog.date_trunc('month', p_month)::date as first_day,
           (pg_catalog.date_trunc('month', p_month) + interval '1 month - 1 day')::date as last_day
  )
  select case p_rule
    when 'last_day' then m.last_day
    when 'last_working_day' then
      m.last_day - case extract(isodow from m.last_day)::int when 6 then 1 when 7 then 2 else 0 end
    when 'first_working_day' then
      m.first_day + case extract(isodow from m.first_day)::int when 6 then 2 when 7 then 1 else 0 end
    else least(m.first_day + (greatest(p_day, 1) - 1), m.last_day)
  end
  from m;
$$;
grant execute on function private.salary_date_in(text, int, date) to authenticated, service_role;

create or replace function private.next_salary_date()
returns date
language sql
stable
set search_path = ''
as $$
  with v as (
    select private.today() as today,
           private.preference_text('salaryRule', 'date') as rule,
           private.preference_int('salaryDay', 1) as day
  )
  select case
    when private.salary_date_in(rule, day, today) > today then private.salary_date_in(rule, day, today)
    else private.salary_date_in(rule, day, (today + interval '1 month')::date)
  end
  from v;
$$;
