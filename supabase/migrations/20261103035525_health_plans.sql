-- Health: a person's plan, the reference notes that make it up, and its dated milestones.
-- Everything belongs to one person, so each account writes its own plan or none at all.

create table public.health_plans (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null default auth.uid() unique references auth.users (id) on delete cascade,
  title            text not null check (char_length(title) between 1 and 80),
  goal             text check (char_length(goal) <= 300),
  starts_on        date not null,
  ends_on          date not null,
  start_weight_kg  numeric(5, 2) check (start_weight_kg between 20 and 400),
  target_weight_kg numeric(5, 2) check (target_weight_kg between 20 and 400),
  ease_in_weeks    int not null default 0 check (ease_in_weeks between 0 and 12),
  ease_in_sets     int not null default 2 check (ease_in_sets between 1 and 10),
  active_routine   text check (char_length(active_routine) <= 60),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  check (ends_on > starts_on),
  constraint health_plans_title_no_long_number check (not private.has_long_number(title)),
  constraint health_plans_goal_no_long_number check (not private.has_long_number(goal))
);

-- One table for every list in a plan, so each list can be edited the same way.
create table public.health_plan_items (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  section    text not null check (section in (
               'stat', 'callout', 'routine', 'meal', 'lift_rule', 'eating_rule',
               'food_note', 'supplement', 'supplement_note', 'activity', 'checklist', 'review'
             )),
  grp        text check (char_length(grp) <= 60),
  position   int not null default 0,
  label      text not null check (char_length(label) between 1 and 600),
  detail     text check (char_length(detail) <= 600),
  value      text check (char_length(value) <= 40),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint health_plan_items_label_no_long_number check (not private.has_long_number(label)),
  constraint health_plan_items_detail_no_long_number check (not private.has_long_number(detail))
);
create index health_plan_items_user_section_idx on public.health_plan_items (user_id, section, position);

create table public.health_checkpoints (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  due_on     date not null,
  label      text not null check (char_length(label) between 1 and 120),
  weight_kg  numeric(5, 2) check (weight_kg between 20 and 400),
  note       text check (char_length(note) <= 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint health_checkpoints_label_no_long_number check (not private.has_long_number(label)),
  constraint health_checkpoints_note_no_long_number check (not private.has_long_number(note))
);
create index health_checkpoints_user_due_idx on public.health_checkpoints (user_id, due_on);

do $$
declare
  t text;
begin
  foreach t in array array['health_plans', 'health_plan_items', 'health_checkpoints'] loop
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
