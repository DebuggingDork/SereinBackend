-- Diet: foods, meals, targets, plans, water and weight.

create table public.foods (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name       text not null check (char_length(name) between 1 and 80),
  serving    text not null default '1 serving' check (char_length(serving) <= 40),
  calories   numeric(7, 1) not null default 0 check (calories >= 0),
  protein    numeric(6, 1) not null default 0 check (protein >= 0),
  carbs      numeric(6, 1) not null default 0 check (carbs >= 0),
  fat        numeric(6, 1) not null default 0 check (fat >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, name)
);

create table public.meal_logs (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  logged_on  date not null default private.today(),
  logged_time time not null default (now() at time zone 'Asia/Kolkata')::time,
  meal_type  text not null check (meal_type in ('breakfast', 'lunch', 'snack', 'dinner')),
  food_id    uuid references public.foods (id) on delete set null,
  name       text not null check (char_length(name) between 1 and 80),
  quantity   numeric(6, 2) not null default 1 check (quantity > 0),
  calories   numeric(7, 1) not null default 0 check (calories >= 0),
  protein    numeric(6, 1) not null default 0 check (protein >= 0),
  carbs      numeric(6, 1) not null default 0 check (carbs >= 0),
  fat        numeric(6, 1) not null default 0 check (fat >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index meal_logs_user_date_idx on public.meal_logs (user_id, logged_on desc);
create index meal_logs_food_idx on public.meal_logs (food_id);

create table public.diet_targets (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() unique references auth.users (id) on delete cascade,
  calories   numeric(7, 1) not null default 2000 check (calories >= 0),
  protein    numeric(6, 1) not null default 120 check (protein >= 0),
  carbs      numeric(6, 1) not null default 220 check (carbs >= 0),
  fat        numeric(6, 1) not null default 65 check (fat >= 0),
  water_ml   int not null default 2500 check (water_ml >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.meal_plans (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  weekday    int not null check (weekday between 0 and 6),
  meal_type  text not null check (meal_type in ('breakfast', 'lunch', 'snack', 'dinner')),
  items      text not null check (char_length(items) <= 300),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, weekday, meal_type)
);

create table public.water_logs (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  logged_on  date not null default private.today(),
  amount_ml  int not null check (amount_ml <> 0 and amount_ml between -5000 and 5000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index water_logs_user_date_idx on public.water_logs (user_id, logged_on desc);

create table public.weight_logs (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  logged_on  date not null default private.today(),
  weight_kg  numeric(5, 2) not null check (weight_kg between 20 and 400),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, logged_on)
);

create function private.seed_diet_targets()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.diet_targets (user_id) values (new.id);
  return new;
end;
$$;

create trigger profiles_seed_diet_targets
  after insert on public.profiles
  for each row execute function private.seed_diet_targets();

do $$
declare
  t text;
begin
  foreach t in array array['foods', 'meal_logs', 'diet_targets', 'meal_plans', 'water_logs', 'weight_logs'] loop
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
    execute format('revoke all on public.%I from anon', t);
  end loop;
end;
$$;
