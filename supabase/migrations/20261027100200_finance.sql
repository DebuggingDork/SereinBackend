-- Finance: accounts, categories, transactions and everything that hangs off them.
-- Balances are typed by the user and moved by transactions. There is no bank sync
-- and no column could ever hold a full card number.

create table public.accounts (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name           text not null check (char_length(name) between 1 and 60 and not private.has_long_number(name)),
  kind           text not null check (kind in ('bank', 'wallet', 'cash', 'card', 'investment')),
  bank_name      text check (char_length(bank_name) <= 60 and not private.has_long_number(bank_name)),
  last_four      text check (last_four ~ '^[0-9]{4}$'),
  -- For cards this is the amount used; for everything else, the amount held.
  balance        numeric(14, 2) not null default 0,
  credit_limit   numeric(14, 2) check (credit_limit >= 0),
  statement_day  int check (statement_day between 1 and 31),
  due_day        int check (due_day between 1 and 31),
  hidden         boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create table public.categories (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name       text not null check (char_length(name) between 1 and 40),
  kind       text not null default 'expense' check (kind in ('expense', 'income')),
  icon       text not null default 'circle',
  color      text not null default '#6b7280',
  parent_id  uuid references public.categories (id) on delete set null,
  archived   boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, kind, name)
);

create table public.transactions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind          text not null check (kind in ('income', 'expense', 'transfer')),
  amount        numeric(14, 2) not null check (amount > 0),
  category_id   uuid references public.categories (id) on delete set null,
  account_id    uuid not null references public.accounts (id) on delete restrict,
  to_account_id uuid references public.accounts (id) on delete restrict,
  payment_app   text check (char_length(payment_app) <= 40),
  occurred_on   date not null default private.today(),
  occurred_time time,
  payee         text check (char_length(payee) <= 80 and not private.has_long_number(payee)),
  notes         text check (char_length(notes) <= 500 and not private.has_long_number(notes)),
  checked       boolean not null default false,
  is_refund     boolean not null default false,
  is_adjustment boolean not null default false,
  tags          text[] not null default '{}',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint transfers_have_a_destination check (
    (kind = 'transfer' and to_account_id is not null and to_account_id <> account_id)
    or (kind <> 'transfer' and to_account_id is null)
  )
);
create index transactions_user_date_idx on public.transactions (user_id, occurred_on desc);
create index transactions_account_idx on public.transactions (account_id);
create index transactions_to_account_idx on public.transactions (to_account_id);
create index transactions_category_idx on public.transactions (category_id);

create table public.transaction_templates (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 40),
  kind        text not null default 'expense' check (kind in ('income', 'expense')),
  amount      numeric(14, 2) not null check (amount > 0),
  category_id uuid references public.categories (id) on delete set null,
  account_id  uuid references public.accounts (id) on delete set null,
  payment_app text,
  payee       text check (not private.has_long_number(payee)),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table public.budgets (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  category_id  uuid not null references public.categories (id) on delete cascade,
  period       text not null check (period in ('weekly', 'monthly')),
  limit_amount numeric(14, 2) not null check (limit_amount > 0),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (user_id, category_id, period)
);

create table public.scheduled_items (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name            text not null check (char_length(name) between 1 and 60),
  kind            text not null default 'expense' check (kind in ('income', 'expense')),
  amount          numeric(14, 2) not null check (amount > 0),
  category_id     uuid references public.categories (id) on delete set null,
  account_id      uuid not null references public.accounts (id) on delete cascade,
  payment_app     text,
  payee           text check (not private.has_long_number(payee)),
  frequency       text not null check (frequency in ('daily', 'weekly', 'monthly', 'yearly', 'custom')),
  interval_days   int check (interval_days between 1 and 3660),
  next_run        date not null,
  auto_post       boolean not null default true,
  is_subscription boolean not null default false,
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint custom_needs_interval check (frequency <> 'custom' or interval_days is not null)
);
create index scheduled_items_due_idx on public.scheduled_items (next_run) where active;

create table public.people (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name       text not null check (char_length(name) between 1 and 60),
  notes      text check (not private.has_long_number(notes)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, name)
);

create table public.debts (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  person_id  uuid not null references public.people (id) on delete cascade,
  direction  text not null check (direction in ('lent', 'borrowed')),
  amount     numeric(14, 2) not null check (amount > 0),
  opened_on  date not null default private.today(),
  due_on     date,
  notes      text check (not private.has_long_number(notes)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index debts_person_idx on public.debts (person_id);

create table public.debt_payments (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid() references auth.users (id) on delete cascade,
  debt_id        uuid not null references public.debts (id) on delete cascade,
  amount         numeric(14, 2) not null check (amount > 0),
  paid_on        date not null default private.today(),
  transaction_id uuid references public.transactions (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index debt_payments_debt_idx on public.debt_payments (debt_id);

create table public.goals (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name         text not null check (char_length(name) between 1 and 60),
  target       numeric(14, 2) not null check (target > 0),
  saved        numeric(14, 2) not null default 0 check (saved >= 0),
  deadline     date,
  account_id   uuid references public.accounts (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table public.net_worth_snapshots (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  taken_on    date not null,
  assets      numeric(14, 2) not null,
  liabilities numeric(14, 2) not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (user_id, taken_on)
);

-- Moves the money. Values are from the point of view of what you own, so spending
-- on a card (which raises its amount used) and from a bank account look the same.
create function private.move_balance(p_account_id uuid, p_delta numeric)
returns void
language sql
set search_path = ''
as $$
  update public.accounts
     set balance = balance + case when kind = 'card' then -p_delta else p_delta end
   where id = p_account_id;
$$;

create function private.apply_transaction()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    if old.kind = 'income' then
      perform private.move_balance(old.account_id, -old.amount);
    elsif old.kind = 'expense' then
      perform private.move_balance(old.account_id, old.amount);
    else
      perform private.move_balance(old.account_id, old.amount);
      perform private.move_balance(old.to_account_id, -old.amount);
    end if;
  end if;

  if tg_op in ('INSERT', 'UPDATE') then
    if new.kind = 'income' then
      perform private.move_balance(new.account_id, new.amount);
    elsif new.kind = 'expense' then
      perform private.move_balance(new.account_id, -new.amount);
    else
      perform private.move_balance(new.account_id, -new.amount);
      perform private.move_balance(new.to_account_id, new.amount);
    end if;
  end if;

  return null;
end;
$$;

create trigger transactions_apply_balance
  after insert or delete or update of kind, amount, account_id, to_account_id
  on public.transactions
  for each row execute function private.apply_transaction();

-- Every new person starts with a sensible set of categories.
create function private.seed_categories()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  transport_id uuid;
begin
  insert into public.categories (user_id, name, kind, icon, color) values
    (new.id, 'Food',          'expense', 'utensils',      '#f59e0b'),
    (new.id, 'Bills',         'expense', 'receipt',       '#3b82f6'),
    (new.id, 'Shopping',      'expense', 'shopping-bag',  '#8b5cf6'),
    (new.id, 'Health',        'expense', 'heart-pulse',   '#ef4444'),
    (new.id, 'Rent',          'expense', 'home',          '#10b981'),
    (new.id, 'Entertainment', 'expense', 'clapperboard',  '#ec4899'),
    (new.id, 'Other',         'expense', 'circle',        '#6b7280'),
    (new.id, 'Salary',        'income',  'wallet',        '#10b981'),
    (new.id, 'Other income',  'income',  'plus-circle',   '#14b8a6');

  insert into public.categories (user_id, name, kind, icon, color)
  values (new.id, 'Transport', 'expense', 'train', '#06b6d4')
  returning id into transport_id;

  insert into public.categories (user_id, name, kind, icon, color, parent_id) values
    (new.id, 'Metro',  'expense', 'train', '#06b6d4', transport_id),
    (new.id, 'Rapido', 'expense', 'bike',  '#06b6d4', transport_id),
    (new.id, 'Uber',   'expense', 'car',   '#06b6d4', transport_id),
    (new.id, 'Fuel',   'expense', 'fuel',  '#06b6d4', transport_id);

  return new;
end;
$$;

create trigger profiles_seed_categories
  after insert on public.profiles
  for each row execute function private.seed_categories();

-- Remaining balance on each debt, ready to read.
create view public.debt_balances
with (security_invoker = true)
as
  select
    d.id,
    d.user_id,
    d.person_id,
    p.name as person_name,
    d.direction,
    d.amount,
    d.opened_on,
    d.due_on,
    d.notes,
    coalesce(sum(pay.amount), 0)::numeric(14, 2) as paid,
    (d.amount - coalesce(sum(pay.amount), 0))::numeric(14, 2) as remaining
  from public.debts d
  join public.people p on p.id = d.person_id
  left join public.debt_payments pay on pay.debt_id = d.id
  group by d.id, p.name;

-- Records a repayment and, when an account is given, the matching transaction.
create function public.record_debt_payment(
  p_debt_id uuid,
  p_amount numeric,
  p_paid_on date default null,
  p_account_id uuid default null
)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  debt record;
  tx_id uuid;
  payment_id uuid;
begin
  select * into debt from public.debt_balances where id = p_debt_id;
  if not found then
    raise exception 'Debt not found';
  end if;
  if p_amount <= 0 or p_amount > debt.remaining then
    raise exception 'Repayment must be between 0 and the remaining %', debt.remaining;
  end if;

  if p_account_id is not null then
    insert into public.transactions (kind, amount, account_id, occurred_on, payee, notes)
    values (
      case when debt.direction = 'lent' then 'income' else 'expense' end,
      p_amount,
      p_account_id,
      coalesce(p_paid_on, private.today()),
      debt.person_name,
      'Debt repayment'
    )
    returning id into tx_id;
  end if;

  insert into public.debt_payments (debt_id, amount, paid_on, transaction_id)
  values (p_debt_id, p_amount, coalesce(p_paid_on, private.today()), tx_id)
  returning id into payment_id;

  return payment_id;
end;
$$;

create function private.next_occurrence(
  p_from date,
  p_frequency text,
  p_interval_days int
)
returns date
language sql
immutable
set search_path = ''
as $$
  select case p_frequency
    when 'daily'   then p_from + 1
    when 'weekly'  then p_from + 7
    when 'monthly' then (p_from + interval '1 month')::date
    when 'yearly'  then (p_from + interval '1 year')::date
    else p_from + coalesce(p_interval_days, 30)
  end;
$$;

-- Posts a due item now. Used when the user confirms one by hand.
create function public.post_scheduled_item(p_id uuid)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  item public.scheduled_items;
  tx_id uuid;
begin
  select * into item from public.scheduled_items where id = p_id for update;
  if not found then
    raise exception 'Scheduled item not found';
  end if;

  insert into public.transactions (kind, amount, category_id, account_id, payment_app, occurred_on, payee, notes)
  values (item.kind, item.amount, item.category_id, item.account_id, item.payment_app,
          item.next_run, coalesce(item.payee, item.name), 'Scheduled')
  returning id into tx_id;

  update public.scheduled_items
     set next_run = private.next_occurrence(next_run, frequency, interval_days)
   where id = p_id;

  return tx_id;
end;
$$;

create function public.skip_scheduled_item(p_id uuid)
returns void
language sql
set search_path = ''
as $$
  update public.scheduled_items
     set next_run = private.next_occurrence(next_run, frequency, interval_days)
   where id = p_id;
$$;

-- What you own and what you owe, right now.
create function public.net_worth_now()
returns table (assets numeric, liabilities numeric, net numeric)
language sql
stable
set search_path = ''
as $$
  with balances as (
    select
      coalesce(sum(balance) filter (where kind <> 'card'), 0) as held,
      coalesce(sum(balance) filter (where kind = 'card'), 0)  as card_dues
    from public.accounts
    where not hidden
  ),
  owed as (
    select
      coalesce(sum(remaining) filter (where direction = 'lent'), 0)     as to_me,
      coalesce(sum(remaining) filter (where direction = 'borrowed'), 0) as by_me
    from public.debt_balances
  )
  select
    b.held + o.to_me as assets,
    b.card_dues + o.by_me as liabilities,
    b.held + o.to_me - b.card_dues - o.by_me as net
  from balances b, owed o;
$$;

-- Saves today's net worth so the trend has history. Safe to call repeatedly.
create function public.capture_net_worth()
returns void
language sql
set search_path = ''
as $$
  insert into public.net_worth_snapshots (taken_on, assets, liabilities)
  select private.today(), n.assets, n.liabilities from public.net_worth_now() n
  on conflict (user_id, taken_on) do update
    set assets = excluded.assets, liabilities = excluded.liabilities;
$$;

-- The next date a salary lands, from the user's preferred salary day.
create function private.next_salary_date()
returns date
language sql
stable
set search_path = ''
as $$
  with v as (
    select private.today() as today, least(private.preference_int('salaryDay', 1), 28) as day
  )
  select case
    when extract(day from today)::int < day
      then date_trunc('month', today)::date + (day - 1)
    else (date_trunc('month', today) + interval '1 month')::date + (day - 1)
  end
  from v;
$$;
grant execute on function private.next_salary_date() to authenticated;

-- One number that answers "what can I spend today?".
create function public.safe_to_spend()
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
    -- What goals need per month, prorated to the days until salary.
    select coalesce(sum(
      greatest(g.target - g.saved, 0)
      / greatest((g.deadline - h.today) / 30.0, 1)
    ), 0) as total
    from public.goals g, horizon h
    where g.deadline is not null and g.deadline > h.today and g.saved < g.target
  ),
  recent as (
    select coalesce(sum(amount), 0) / 30.0 as daily
    from public.transactions t, horizon h
    where t.kind = 'expense' and t.occurred_on > h.today - 30
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

-- Spend per budget for the current period, with how far through the period we are.
create function public.budget_progress()
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
      and (t.category_id = w.category_id or tc.parent_id = w.category_id)
      and t.occurred_on between w.period_start and w.period_end
  ) s on true
  order by c.name;
$$;

do $$
declare
  t text;
begin
  foreach t in array array[
    'accounts', 'categories', 'transactions', 'transaction_templates', 'budgets',
    'scheduled_items', 'people', 'debts', 'debt_payments', 'goals', 'net_worth_snapshots'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy "Own rows after the gate" on public.%I for all to authenticated
         using (user_id = (select auth.uid()) and (select private.gate_ok()))
         with check (user_id = (select auth.uid()) and (select private.gate_ok()))',
      t
    );
    execute format(
      'create trigger %I before update on public.%I
         for each row execute function private.set_updated_at()',
      t || '_set_updated_at', t
    );
    execute format('create index %I on public.%I (user_id)', t || '_user_id_idx', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
end;
$$;
