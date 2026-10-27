-- The daily reminder from plan section 9: bills, tasks and loans due. The backend sends
-- the mail, so this only says who is owed one. Anyone can opt out with the preference
-- emailReminders = false.

create table public.reminder_runs (
  user_id    uuid not null references auth.users (id) on delete cascade,
  sent_on    date not null,
  created_at timestamptz not null default now(),
  primary key (user_id, sent_on)
);
alter table public.reminder_runs enable row level security;
revoke all on public.reminder_runs from anon, authenticated;

create function public.due_reminders()
returns table (user_id uuid, email text, local_day date, kind text, title text, due_on date, amount numeric)
language sql
stable
security definer
set search_path = ''
as $$
  with people as (
    select
      p.id,
      u.email::text as email,
      (now() at time zone private.safe_timezone(p.preferences ->> 'timezone'))::date as today
    from public.profiles p
    join auth.users u on u.id = p.id
    where u.email is not null
      and u.email_confirmed_at is not null
      and coalesce(p.preferences ->> 'emailReminders', 'true') <> 'false'
  ),
  waiting as (
    select pe.* from people pe
    where not exists (
      select 1 from public.reminder_runs r where r.user_id = pe.id and r.sent_on = pe.today
    )
  )
  select w.id, w.email, w.today, 'bill', s.name, s.next_run, s.amount
  from waiting w
  join public.scheduled_items s on s.user_id = w.id
  where s.active and s.kind = 'expense' and s.next_run <= w.today + 1

  union all
  select w.id, w.email, w.today, 'task', t.title, t.due_on, null::numeric
  from waiting w
  join public.tasks t on t.user_id = w.id
  where t.status in ('todo', 'doing') and t.parent_id is null and t.due_on <= w.today

  union all
  select w.id, w.email, w.today, 'loan', d.person_name, d.due_on, d.remaining
  from waiting w
  join public.debt_balances d on d.user_id = w.id
  where d.remaining > 0 and d.due_on <= w.today + 1

  order by 1, 6;
$$;

revoke execute on function public.due_reminders() from public, anon, authenticated;
grant execute on function public.due_reminders() to service_role;
