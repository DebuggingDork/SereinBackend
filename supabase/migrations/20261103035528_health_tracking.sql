-- The daily checklist and body measurements such as waist and body scans.

create table public.health_checkins (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  logged_on  date not null default private.today(),
  done       uuid[] not null default '{}',
  total      int not null default 0 check (total >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, logged_on)
);

create table public.body_measurements (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null default auth.uid() references auth.users (id) on delete cascade,
  logged_on       date not null default private.today(),
  waist_cm        numeric(5, 1) check (waist_cm between 20 and 300),
  body_fat_pct    numeric(4, 1) check (body_fat_pct between 1 and 80),
  muscle_kg       numeric(5, 2) check (muscle_kg between 1 and 200),
  trunk_fat_kg    numeric(5, 2) check (trunk_fat_kg between 0 and 200),
  waist_hip_ratio numeric(4, 2) check (waist_hip_ratio between 0.3 and 2),
  note            text check (char_length(note) <= 200),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (user_id, logged_on),
  constraint body_measurements_note_no_long_number check (not private.has_long_number(note))
);

do $$
declare
  t text;
begin
  foreach t in array array['health_checkins', 'body_measurements'] loop
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
