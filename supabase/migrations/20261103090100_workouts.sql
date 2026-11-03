-- Workouts: a weekly template, and the sessions and sets logged against it. Sets keep the
-- exercise name, so history survives editing or removing the exercise from the template.

create table public.workout_days (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  weekday    int not null check (weekday between 0 and 6),
  title      text not null check (char_length(title) between 1 and 80),
  summary    text check (char_length(summary) <= 300),
  kind       text not null default 'lift' check (kind in ('lift', 'cardio', 'rest')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, weekday),
  unique (id, user_id),
  constraint workout_days_title_no_long_number check (not private.has_long_number(title)),
  constraint workout_days_summary_no_long_number check (not private.has_long_number(summary))
);

create table public.workout_exercises (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  day_id     uuid not null,
  position   int not null default 0,
  name       text not null check (char_length(name) between 1 and 80),
  target     text not null check (char_length(target) between 1 and 40),
  sets       int not null default 1 check (sets between 1 and 20),
  measure    text not null default 'reps' check (measure in ('reps', 'time')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id),
  foreign key (day_id, user_id) references public.workout_days (id, user_id) on delete cascade,
  constraint workout_exercises_name_no_long_number check (not private.has_long_number(name))
);
create index workout_exercises_day_idx on public.workout_exercises (day_id, user_id, position);
create index workout_exercises_user_idx on public.workout_exercises (user_id);

create table public.workout_sessions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  logged_on    date not null default private.today(),
  day_id       uuid,
  title        text not null check (char_length(title) between 1 and 80),
  kind         text not null default 'lift' check (kind in ('lift', 'cardio', 'rest', 'game')),
  minutes      int check (minutes between 1 and 600),
  kcal         int check (kcal between 0 and 10000),
  notes        text check (char_length(notes) <= 500),
  completed_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (user_id, logged_on),
  unique (id, user_id),
  foreign key (day_id, user_id) references public.workout_days (id, user_id) on delete set null (day_id),
  constraint workout_sessions_title_no_long_number check (not private.has_long_number(title)),
  constraint workout_sessions_notes_no_long_number check (not private.has_long_number(notes))
);
create index workout_sessions_day_idx on public.workout_sessions (day_id, user_id);

create table public.workout_sets (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users (id) on delete cascade,
  session_id    uuid not null,
  exercise_id   uuid,
  exercise_name text not null check (char_length(exercise_name) between 1 and 80),
  set_no        int not null check (set_no between 1 and 20),
  weight_kg     numeric(6, 2) check (weight_kg between 0 and 1000),
  reps          int check (reps between 0 and 500),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (session_id, exercise_name, set_no),
  foreign key (session_id, user_id) references public.workout_sessions (id, user_id) on delete cascade,
  foreign key (exercise_id, user_id) references public.workout_exercises (id, user_id) on delete set null (exercise_id)
);
create index workout_sets_user_exercise_idx on public.workout_sets (user_id, exercise_name, created_at desc);
create index workout_sets_session_idx on public.workout_sets (session_id, user_id);
create index workout_sets_exercise_idx on public.workout_sets (exercise_id, user_id);

do $$
declare
  t text;
begin
  foreach t in array array['workout_days', 'workout_exercises', 'workout_sessions', 'workout_sets'] loop
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
