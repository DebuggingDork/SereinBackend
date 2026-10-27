-- private.today() is a security definer function, so Postgres cannot inline it. Used
-- bare in a filter it can run once per row, which took macro_split from under 1 ms to
-- about 200 ms for a user with a few years of meals. As an uncorrelated subquery it runs
-- once and the index on (user_id, logged_on) becomes usable.

create or replace function public.macro_split(p_day date default null)
returns table (protein numeric, carbs numeric, fat numeric, calories numeric)
language sql stable set search_path = ''
as $$
  select
    coalesce(sum(m.protein), 0),
    coalesce(sum(m.carbs), 0),
    coalesce(sum(m.fat), 0),
    coalesce(sum(m.calories), 0)
  from public.meal_logs m
  where m.logged_on = (select coalesce(p_day, private.today()));
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
      where kind = 'expense' and occurred_on = v.today
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
