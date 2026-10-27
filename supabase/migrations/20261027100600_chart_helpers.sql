-- Chart helpers. Each one runs as the calling user, so row-level security keeps
-- results private, and returns rows shaped for a chart, with empty days filled in.

-- Finance -------------------------------------------------------------------

create function public.spending_by_category(p_from date, p_to date)
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
  where t.kind = 'expense' and t.occurred_on between p_from and p_to
  group by 1, 2
  order by 3 desc;
$$;

create function public.income_vs_expense(p_months int default 6)
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
  left join public.transactions t on date_trunc('month', t.occurred_on) = m
  group by m
  order by m;
$$;

create function public.daily_spending(p_days int default 30)
returns table (day date, total numeric)
language sql stable set search_path = ''
as $$
  select d::date, coalesce(sum(t.amount), 0)
  from generate_series(private.today() - (p_days - 1), private.today(), interval '1 day') d
  left join public.transactions t on t.occurred_on = d::date and t.kind = 'expense'
  group by d
  order by d;
$$;

-- Walks back from today's balance by undoing each day's transactions.
create function public.balance_trend(p_days int default 30)
returns table (day date, balance numeric)
language sql stable set search_path = ''
as $$
  with current_total as (
    select coalesce(sum(case when kind = 'card' then -balance else balance end), 0) as total
    from public.accounts where not hidden
  ),
  flows as (
    select t.occurred_on as day,
      sum(case t.kind when 'income' then t.amount when 'expense' then -t.amount else 0 end) as net
    from public.transactions t
    join public.accounts a on a.id = t.account_id and not a.hidden
    group by 1
  ),
  days as (
    select d::date as day
    from generate_series(private.today() - (p_days - 1), private.today(), interval '1 day') d
  )
  select
    days.day,
    (select total from current_total)
      - coalesce((select sum(f.net) from flows f where f.day > days.day), 0)
  from days
  order by days.day;
$$;

create function public.spending_by_source(p_from date, p_to date)
returns table (account text, payment_app text, total numeric)
language sql stable set search_path = ''
as $$
  select a.name, coalesce(nullif(t.payment_app, ''), 'Direct'), sum(t.amount)
  from public.transactions t
  join public.accounts a on a.id = t.account_id
  where t.kind = 'expense' and t.occurred_on between p_from and p_to
  group by 1, 2
  order by 3 desc;
$$;

-- Projected subscription cost for each of the coming months.
create function public.subscription_cost_by_month(p_months int default 12)
returns table (month date, total numeric)
language sql stable set search_path = ''
as $$
  with months as (
    select m::date as month
    from generate_series(
      date_trunc('month', private.today()),
      date_trunc('month', private.today()) + make_interval(months => p_months - 1),
      interval '1 month'
    ) m
  ),
  charges as (
    select date_trunc('month', due)::date as month, s.amount
    from public.scheduled_items s
    cross join lateral generate_series(
      s.next_run::timestamp,
      (date_trunc('month', private.today()) + make_interval(months => p_months))::timestamp - interval '1 day',
      case s.frequency
        when 'daily'   then interval '1 day'
        when 'weekly'  then interval '7 days'
        when 'monthly' then interval '1 month'
        when 'yearly'  then interval '1 year'
        else make_interval(days => coalesce(s.interval_days, 30))
      end
    ) as due
    where s.active and s.is_subscription and s.kind = 'expense'
  )
  select m.month, coalesce(sum(c.amount), 0)
  from months m
  left join charges c on c.month = m.month
  group by m.month
  order by m.month;
$$;

create function public.debts_by_person()
returns table (person text, owed_to_me numeric, i_owe numeric)
language sql stable set search_path = ''
as $$
  select
    person_name,
    coalesce(sum(remaining) filter (where direction = 'lent'), 0),
    coalesce(sum(remaining) filter (where direction = 'borrowed'), 0)
  from public.debt_balances
  where remaining > 0
  group by 1
  order by sum(remaining) desc;
$$;

-- Planner -------------------------------------------------------------------

create function public.completion_rate_daily(p_days int default 30)
returns table (day date, due int, completed int, rate numeric)
language sql stable set search_path = ''
as $$
  with tz as (
    select coalesce(p.preferences ->> 'timezone', 'Asia/Kolkata') as name
    from public.profiles p where p.id = auth.uid()
  )
  select
    d::date,
    count(t.id)::int,
    count(t.id) filter (where t.status = 'done')::int,
    case when count(t.id) = 0 then null
         else round(100.0 * count(t.id) filter (where t.status = 'done') / count(t.id), 0)
    end
  from generate_series(private.today() - (p_days - 1), private.today(), interval '1 day') d
  left join public.tasks t
    on coalesce(t.due_on, (t.created_at at time zone (select name from tz))::date) = d::date
   and t.parent_id is null
   and t.status <> 'dropped'
  group by d
  order by d;
$$;

create function public.tasks_created_vs_completed(p_weeks int default 8)
returns table (week date, created int, completed int)
language sql stable set search_path = ''
as $$
  with weeks as (
    select w::date as week
    from generate_series(
      date_trunc('week', private.today()::timestamp) - make_interval(weeks => p_weeks - 1),
      date_trunc('week', private.today()::timestamp),
      interval '1 week'
    ) w
  )
  select
    w.week,
    (select count(*) from public.tasks t
      where t.created_at >= w.week and t.created_at < w.week + 7)::int,
    (select count(*) from public.tasks t
      where t.completed_at >= w.week and t.completed_at < w.week + 7)::int
  from weeks w
  order by w.week;
$$;

create function public.tasks_by_category()
returns table (category text, total int)
language sql stable set search_path = ''
as $$
  select coalesce(nullif(category, ''), 'Uncategorised'), count(*)::int
  from public.tasks
  where parent_id is null and status <> 'dropped'
  group by 1
  order by 2 desc;
$$;

create function public.on_time_vs_late(p_weeks int default 8)
returns table (week date, on_time int, late int)
language sql stable set search_path = ''
as $$
  with tz as (
    select coalesce(p.preferences ->> 'timezone', 'Asia/Kolkata') as name
    from public.profiles p where p.id = auth.uid()
  ),
  weeks as (
    select w::date as week
    from generate_series(
      date_trunc('week', private.today()::timestamp) - make_interval(weeks => p_weeks - 1),
      date_trunc('week', private.today()::timestamp),
      interval '1 week'
    ) w
  ),
  finished as (
    select
      (t.completed_at at time zone (select name from tz))::date as done_on,
      t.due_on
    from public.tasks t
    where t.status = 'done' and t.completed_at is not null and t.due_on is not null
  )
  select
    w.week,
    count(*) filter (where f.done_on <= f.due_on)::int,
    count(*) filter (where f.done_on > f.due_on)::int
  from weeks w
  left join finished f on f.done_on >= w.week and f.done_on < w.week + 7
  group by w.week
  order by w.week;
$$;

-- Longest and current run of consecutive dates. The current run stays alive
-- through today until today has passed.
create function private.streaks(p_dates date[])
returns table (current_streak int, longest_streak int)
language sql stable set search_path = ''
as $$
  with days as (select distinct unnest(p_dates) as d),
  islands as (
    select d, d - (row_number() over (order by d))::int as island from days
  ),
  runs as (
    select min(d) as first_day, max(d) as last_day, count(*)::int as length
    from islands group by island
  )
  select
    coalesce((select length from runs where last_day >= private.today() - 1 order by last_day desc limit 1), 0),
    coalesce((select max(length) from runs), 0);
$$;
grant execute on function private.streaks(date[]) to authenticated;

create function public.task_streaks()
returns table (current_streak int, longest_streak int)
language sql stable set search_path = ''
as $$
  select * from private.streaks(array(
    select (t.completed_at at time zone coalesce(
      (select p.preferences ->> 'timezone' from public.profiles p where p.id = auth.uid()),
      'Asia/Kolkata'
    ))::date
    from public.tasks t
    where t.status = 'done' and t.completed_at is not null
  ));
$$;

-- Diet ----------------------------------------------------------------------

create function public.daily_calories(p_days int default 14)
returns table (day date, calories numeric, target numeric)
language sql stable set search_path = ''
as $$
  select
    d::date,
    coalesce(sum(m.calories), 0),
    coalesce((select dt.calories from public.diet_targets dt limit 1), 2000)
  from generate_series(private.today() - (p_days - 1), private.today(), interval '1 day') d
  left join public.meal_logs m on m.logged_on = d::date
  group by d
  order by d;
$$;

create function public.macro_split(p_day date default null)
returns table (protein numeric, carbs numeric, fat numeric, calories numeric)
language sql stable set search_path = ''
as $$
  select
    coalesce(sum(m.protein), 0),
    coalesce(sum(m.carbs), 0),
    coalesce(sum(m.fat), 0),
    coalesce(sum(m.calories), 0)
  from public.meal_logs m
  where m.logged_on = coalesce(p_day, private.today());
$$;

create function public.weekly_macros(p_weeks int default 8)
returns table (week date, protein numeric, carbs numeric, fat numeric)
language sql stable set search_path = ''
as $$
  with weeks as (
    select w::date as week
    from generate_series(
      date_trunc('week', private.today()::timestamp) - make_interval(weeks => p_weeks - 1),
      date_trunc('week', private.today()::timestamp),
      interval '1 week'
    ) w
  )
  select
    w.week,
    -- Average per logged day, so a part-filled week is not understated.
    round(coalesce(sum(m.protein) / nullif(count(distinct m.logged_on), 0), 0), 1),
    round(coalesce(sum(m.carbs) / nullif(count(distinct m.logged_on), 0), 0), 1),
    round(coalesce(sum(m.fat) / nullif(count(distinct m.logged_on), 0), 0), 1)
  from weeks w
  left join public.meal_logs m on m.logged_on >= w.week and m.logged_on < w.week + 7
  group by w.week
  order by w.week;
$$;

create function public.daily_water(p_days int default 14)
returns table (day date, amount_ml int, goal_ml int)
language sql stable set search_path = ''
as $$
  select
    d::date,
    greatest(coalesce(sum(w.amount_ml), 0), 0)::int,
    coalesce((select dt.water_ml from public.diet_targets dt limit 1), 2500)
  from generate_series(private.today() - (p_days - 1), private.today(), interval '1 day') d
  left join public.water_logs w on w.logged_on = d::date
  group by d
  order by d;
$$;

create function public.meal_timing(p_days int default 30)
returns table (hour int, meals int)
language sql stable set search_path = ''
as $$
  select h, count(m.id)::int
  from generate_series(5, 23) h
  left join public.meal_logs m
    on extract(hour from m.logged_time)::int = h
   and m.logged_on > private.today() - p_days
  group by h
  order by h;
$$;

-- Diary ---------------------------------------------------------------------

create function private.mood_score(p_mood text)
returns int
language sql immutable set search_path = ''
as $$
  select case p_mood
    when 'bright'   then 5
    when 'settled'  then 4
    when 'restless' then 3
    when 'tired'    then 2
    when 'low'      then 1
  end;
$$;
grant execute on function private.mood_score(text) to authenticated;

create function public.mood_series(p_days int default 30)
returns table (day date, score numeric, mood text)
language sql stable set search_path = ''
as $$
  select
    d::date,
    round(avg(private.mood_score(e.mood)), 2),
    (array_agg(e.mood order by e.created_at desc) filter (where e.mood is not null))[1]
  from generate_series(private.today() - (p_days - 1), private.today(), interval '1 day') d
  left join public.diary_entries e on e.entry_on = d::date
  group by d
  order by d;
$$;

create function public.mood_counts(p_days int default 30)
returns table (mood text, total int)
language sql stable set search_path = ''
as $$
  select m, count(e.id)::int
  from unnest(array['bright', 'settled', 'restless', 'tired', 'low']) with ordinality as u(m, ord)
  left join public.diary_entries e
    on e.mood = m and e.entry_on > private.today() - p_days
  group by m, u.ord
  order by u.ord;
$$;

create function public.entries_per_week(p_weeks int default 12)
returns table (week date, total int)
language sql stable set search_path = ''
as $$
  select w::date, count(e.id)::int
  from generate_series(
    date_trunc('week', private.today()::timestamp) - make_interval(weeks => p_weeks - 1),
    date_trunc('week', private.today()::timestamp),
    interval '1 week'
  ) w
  left join public.diary_entries e on e.entry_on >= w::date and e.entry_on < w::date + 7
  group by w
  order by w;
$$;

create function public.writing_streak()
returns table (current_streak int, longest_streak int)
language sql stable set search_path = ''
as $$
  select * from private.streaks(array(select entry_on from public.diary_entries));
$$;

-- Home ----------------------------------------------------------------------

-- Everything that deserves attention soon, newest risk first.
create function public.upcoming_alerts()
returns table (kind text, title text, due_on date, amount numeric, severity text, href text)
language sql stable set search_path = ''
as $$
  with v as (select private.today() as today)
  select * from (
    select 'bill', s.name, s.next_run, s.amount,
      case when s.next_run <= v.today then 'high' else 'normal' end,
      '/finance/scheduled'
    from public.scheduled_items s, v
    where s.active and s.kind = 'expense' and s.next_run <= v.today + 7

    union all
    select 'card', a.name || ' payment',
      case
        when extract(day from v.today)::int <= least(a.due_day, 28)
          then date_trunc('month', v.today)::date + (least(a.due_day, 28) - 1)
        else (date_trunc('month', v.today) + interval '1 month')::date + (least(a.due_day, 28) - 1)
      end,
      a.balance, 'normal', '/finance/accounts'
    from public.accounts a, v
    where a.kind = 'card' and a.due_day is not null and a.balance > 0

    union all
    select
      case when d.direction = 'lent' then 'collect' else 'repay' end,
      case when d.direction = 'lent' then d.person_name || ' owes you' else 'You owe ' || d.person_name end,
      d.due_on, d.remaining,
      case when d.due_on < v.today then 'high' else 'normal' end,
      '/finance/debts'
    from public.debt_balances d, v
    where d.remaining > 0 and d.due_on <= v.today + 7

    union all
    select 'budget', b.category_name || ' budget at ' || round(100 * b.spent / b.limit_amount) || '%',
      b.period_end, b.remaining,
      case when b.spent >= b.limit_amount then 'high' else 'normal' end,
      '/finance/budgets'
    from public.budget_progress() b
    where b.spent >= b.limit_amount * 0.8

    union all
    select 'task', t.title, t.due_on, null::numeric,
      case when t.due_on < v.today then 'high' else 'normal' end,
      '/planner/deadlines'
    from public.tasks t, v
    where t.status in ('todo', 'doing') and t.parent_id is null and t.due_on <= v.today
  ) alerts (kind, title, due_on, amount, severity, href)
  order by (severity = 'high') desc, due_on nulls last
  limit 20;
$$;

-- One-call summary for the combined home's default widgets.
create function public.home_summary()
returns jsonb
language sql stable set search_path = ''
as $$
  select jsonb_build_object(
    'today', private.today(),
    'net_worth', (select to_jsonb(n) from public.net_worth_now() n),
    'safe_to_spend', (select to_jsonb(s) from public.safe_to_spend() s),
    'spent_today', (
      select coalesce(sum(amount), 0) from public.transactions
      where kind = 'expense' and occurred_on = private.today()
    ),
    'tasks', (
      select jsonb_build_object(
        'due', count(*) filter (where status in ('todo', 'doing')),
        'done', count(*) filter (where status = 'done')
      )
      from public.tasks
      where parent_id is null and status <> 'dropped'
        and (due_on = private.today()
             or (due_on < private.today() and status in ('todo', 'doing')))
    ),
    'task_streak', (select current_streak from public.task_streaks()),
    'nutrition', (select to_jsonb(m) from public.macro_split() m),
    'targets', (select to_jsonb(t) from public.diet_targets t limit 1),
    'water_ml', (
      select coalesce(sum(amount_ml), 0) from public.water_logs where logged_on = private.today()
    ),
    'latest_entry', (
      select jsonb_build_object('entry_on', e.entry_on, 'title', e.title, 'mood', e.mood, 'body', left(e.body, 200))
      from public.diary_entries e
      order by e.entry_on desc, e.created_at desc
      limit 1
    )
  );
$$;
