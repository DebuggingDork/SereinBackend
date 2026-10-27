-- Corrections to the numbers on the charts.
--
-- A balance adjustment fixes a typed balance. It is stored as a transaction so the
-- balance moves, but it was never really earned or spent, so it no longer counts as
-- income or spending. balance_trend keeps it, because the money line did move.

create or replace function public.spending_by_category(p_from date, p_to date)
returns table (category text, color text, total numeric)
language sql stable set search_path = ''
as $$
  select
    coalesce(parent.name, c.name, 'Uncategorised'),
    coalesce(parent.color, c.color, '#6b7280'),
    sum(t.amount)
  from public.transactions t
  left join public.categories c on c.id = t.category_id
  left join public.categories parent on parent.id = c.parent_id
  where t.kind = 'expense' and not t.is_adjustment and t.occurred_on between p_from and p_to
  group by 1, 2
  order by 3 desc;
$$;

create or replace function public.income_vs_expense(p_months int default 6)
returns table (month date, income numeric, expense numeric)
language sql stable set search_path = ''
as $$
  select
    m::date,
    coalesce(sum(t.amount) filter (where t.kind = 'income'), 0),
    coalesce(sum(t.amount) filter (where t.kind = 'expense'), 0)
  from generate_series(
    date_trunc('month', private.today()) - make_interval(months => p_months - 1),
    date_trunc('month', private.today()),
    interval '1 month'
  ) m
  left join public.transactions t on date_trunc('month', t.occurred_on) = m and not t.is_adjustment
  group by m
  order by m;
$$;

create or replace function public.daily_spending(p_days int default 30)
returns table (day date, total numeric)
language sql stable set search_path = ''
as $$
  select d::date, coalesce(sum(t.amount), 0)
  from generate_series(private.today() - (p_days - 1), private.today(), interval '1 day') d
  left join public.transactions t
    on t.occurred_on = d::date and t.kind = 'expense' and not t.is_adjustment
  group by d
  order by d;
$$;

create or replace function public.spending_by_source(p_from date, p_to date)
returns table (account text, payment_app text, total numeric)
language sql stable set search_path = ''
as $$
  select a.name, coalesce(nullif(t.payment_app, ''), 'Direct'), sum(t.amount)
  from public.transactions t
  join public.accounts a on a.id = t.account_id
  where t.kind = 'expense' and not t.is_adjustment and t.occurred_on between p_from and p_to
  group by 1, 2
  order by 3 desc;
$$;

create or replace function public.budget_progress()
returns table (
  id uuid,
  category_id uuid,
  category_name text,
  category_color text,
  period text,
  limit_amount numeric,
  spent numeric,
  remaining numeric,
  period_start date,
  period_end date,
  elapsed numeric
)
language sql
stable
set search_path = ''
as $$
  with today as (select private.today() as d),
  bounds as (
    select
      t.d,
      -- Start of week from the weekStart preference (0 = Sunday, 1 = Monday, ...).
      t.d - ((extract(dow from t.d)::int - private.preference_int('weekStart', 1) + 7) % 7) as week_start,
      case
        when extract(day from t.d)::int >= least(private.preference_int('monthStart', 1), 28)
          then date_trunc('month', t.d)::date + (least(private.preference_int('monthStart', 1), 28) - 1)
        else (date_trunc('month', t.d) - interval '1 month')::date + (least(private.preference_int('monthStart', 1), 28) - 1)
      end as month_start
    from today t
  ),
  windows as (
    select
      b.id, b.category_id, b.period, b.limit_amount,
      case when b.period = 'weekly' then k.week_start else k.month_start end as period_start,
      case when b.period = 'weekly' then k.week_start + 6
           else (k.month_start + interval '1 month')::date - 1 end as period_end,
      k.d as today
    from public.budgets b, bounds k
  )
  select
    w.id,
    w.category_id,
    c.name,
    c.color,
    w.period,
    w.limit_amount,
    coalesce(s.spent, 0)::numeric(14, 2),
    (w.limit_amount - coalesce(s.spent, 0))::numeric(14, 2),
    w.period_start,
    w.period_end,
    round((w.today - w.period_start + 1)::numeric / (w.period_end - w.period_start + 1), 3)
  from windows w
  join public.categories c on c.id = w.category_id
  left join lateral (
    select sum(t.amount) as spent
    from public.transactions t
    left join public.categories tc on tc.id = t.category_id
    where t.kind = 'expense'
      and not t.is_adjustment
      and (t.category_id = w.category_id or tc.parent_id = w.category_id)
      and t.occurred_on between w.period_start and w.period_end
  ) s on true
  order by c.name;
$$;

-- Besides dropping adjustments from the daily average, this now does what its comment
-- always said: a goal's monthly need is prorated to the days left until salary, rather
-- than setting aside a whole month's saving when payday is tomorrow.
create or replace function public.safe_to_spend()
returns table (
  available numeric,
  committed numeric,
  set_aside numeric,
  remaining numeric,
  days_left int,
  per_day numeric,
  daily_average numeric,
  status text
)
language sql
stable
set search_path = ''
as $$
  with horizon as (
    select private.today() as today, private.next_salary_date() as salary_on
  ),
  money as (
    select coalesce(sum(balance), 0) as available
    from public.accounts
    where not hidden and kind in ('bank', 'wallet', 'cash')
  ),
  bills as (
    select coalesce(sum(s.amount), 0) as total
    from public.scheduled_items s
    cross join horizon h
    cross join lateral generate_series(
      s.next_run::timestamp,
      (h.salary_on - 1)::timestamp,
      case s.frequency
        when 'daily'   then interval '1 day'
        when 'weekly'  then interval '7 days'
        when 'monthly' then interval '1 month'
        when 'yearly'  then interval '1 year'
        else make_interval(days => coalesce(s.interval_days, 30))
      end
    ) as due
    where s.active and s.kind = 'expense'
  ),
  cards as (
    select coalesce(sum(balance), 0) as total from public.accounts where kind = 'card'
  ),
  owed as (
    select coalesce(sum(d.remaining), 0) as total
    from public.debt_balances d, horizon h
    where d.direction = 'borrowed' and d.remaining > 0 and d.due_on < h.salary_on
  ),
  saving as (
    select coalesce(sum(
      greatest(g.target - g.saved, 0)
      / greatest((g.deadline - h.today) / 30.0, 1)
      * least((h.salary_on - h.today) / 30.0, 1)
    ), 0) as total
    from public.goals g, horizon h
    where g.deadline is not null and g.deadline > h.today and g.saved < g.target
  ),
  recent as (
    select coalesce(sum(amount), 0) / 30.0 as daily
    from public.transactions t, horizon h
    where t.kind = 'expense' and not t.is_adjustment and t.occurred_on > h.today - 30
  ),
  totals as (
    select
      m.available,
      b.total + c.total + o.total as committed,
      s.total as set_aside,
      greatest(h.salary_on - h.today, 1) as days_left,
      r.daily
    from money m, bills b, cards c, owed o, saving s, horizon h, recent r
  )
  select
    available::numeric(14, 2),
    committed::numeric(14, 2),
    set_aside::numeric(14, 2),
    (available - committed - set_aside)::numeric(14, 2) as remaining,
    days_left,
    round((available - committed - set_aside) / days_left, 0) as per_day,
    round(daily, 0) as daily_average,
    case
      when available - committed - set_aside <= 0 then 'over'
      when (available - committed - set_aside) / days_left < daily then 'tight'
      else 'comfortable'
    end as status
  from totals;
$$;

create or replace function public.home_summary()
returns jsonb
language sql stable set search_path = ''
as $$
  with v as materialized (select private.today() as today)
  select jsonb_build_object(
    'today', v.today,
    'net_worth', (select to_jsonb(n) from public.net_worth_now() n),
    'safe_to_spend', (select to_jsonb(s) from public.safe_to_spend() s),
    'spent_today', (
      select coalesce(sum(amount), 0) from public.transactions
      where kind = 'expense' and not is_adjustment and occurred_on = v.today
    ),
    'tasks', (
      select jsonb_build_object(
        'due', count(*) filter (where status in ('todo', 'doing')),
        'done', count(*) filter (where status = 'done')
      )
      from public.tasks
      where parent_id is null and status <> 'dropped'
        and (due_on = v.today
             or (due_on < v.today and status in ('todo', 'doing')))
    ),
    'task_streak', (select current_streak from public.task_streaks()),
    'nutrition', (select to_jsonb(m) from public.macro_split(v.today) m),
    'targets', (select to_jsonb(t) from public.diet_targets t limit 1),
    'water_ml', (
      select coalesce(sum(amount_ml), 0) from public.water_logs where logged_on = v.today
    ),
    'latest_entry', (
      select jsonb_build_object('entry_on', e.entry_on, 'title', e.title, 'mood', e.mood, 'body', left(e.body, 200))
      from public.diary_entries e
      order by e.entry_on desc, e.created_at desc
      limit 1
    )
  )
  from v;
$$;

-- Weeks were cut at midnight in the database's timezone, so a task made early on Monday
-- morning in India landed in the week before. They now follow the user's own clock.
create or replace function public.tasks_created_vs_completed(p_weeks int default 8)
returns table (week date, created int, completed int)
language sql stable set search_path = ''
as $$
  with tz as materialized (
    select coalesce(
      (select p.preferences ->> 'timezone' from public.profiles p where p.id = auth.uid()),
      'Asia/Kolkata'
    ) as name
  ),
  weeks as (
    select w::timestamp as week
    from generate_series(
      date_trunc('week', private.today()::timestamp) - make_interval(weeks => p_weeks - 1),
      date_trunc('week', private.today()::timestamp),
      interval '1 week'
    ) w
  )
  select
    w.week::date,
    (select count(*) from public.tasks t
      where t.created_at >= (w.week at time zone (select name from tz))
        and t.created_at < ((w.week + interval '7 days') at time zone (select name from tz)))::int,
    (select count(*) from public.tasks t
      where t.completed_at >= (w.week at time zone (select name from tz))
        and t.completed_at < ((w.week + interval '7 days') at time zone (select name from tz)))::int
  from weeks w
  order by w.week;
$$;

comment on column public.profiles.gate_required is
  'Reserved by the plan. Nothing reads it and it cannot be written from the browser: the gate always applies.';
