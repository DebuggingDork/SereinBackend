-- balance_trend added up a user's whole transaction history once for every day on the
-- chart, though only days inside the window can change the answer. It now reads just
-- those, which took it from 77 ms to about 10 ms on 20,000 transactions.
--
-- It also treated every transfer as moving nothing. A transfer into or out of a hidden
-- account does change the visible total, so each side now counts on its own.

create or replace function public.balance_trend(p_days int default 30)
returns table (day date, balance numeric)
language sql stable set search_path = ''
as $$
  with v as materialized (select private.today() - (p_days - 1) as first_day, private.today() as today),
  current_total as (
    select coalesce(sum(case when kind = 'card' then -balance else balance end), 0) as total
    from public.accounts where not hidden
  ),
  movements as (
    select t.occurred_on as day,
      case when t.kind = 'income' then t.amount else -t.amount end as net
    from public.transactions t
    join public.accounts a on a.id = t.account_id and not a.hidden
    where t.occurred_on > (select first_day from v)
    union all
    select t.occurred_on, t.amount
    from public.transactions t
    join public.accounts a on a.id = t.to_account_id and not a.hidden
    where t.kind = 'transfer' and t.occurred_on > (select first_day from v)
  ),
  flows as materialized (
    select m.day, sum(m.net) as net from movements m group by m.day
  ),
  days as (
    select d::date as day
    from v, generate_series(v.first_day, v.today, interval '1 day') d
  )
  select
    days.day,
    (select total from current_total)
      - coalesce((select sum(f.net) from flows f where f.day > days.day), 0)
  from days
  order by days.day;
$$;
