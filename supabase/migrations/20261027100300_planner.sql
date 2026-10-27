-- Planner: tasks with subtasks, recurrence and completion history.

create table public.tasks (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title            text not null check (char_length(title) between 1 and 200),
  notes            text check (char_length(notes) <= 2000),
  priority         text not null default 'medium' check (priority in ('low', 'medium', 'high')),
  status           text not null default 'todo' check (status in ('todo', 'doing', 'done', 'dropped')),
  due_on           date,
  due_time         time,
  completed_at     timestamptz,
  category         text check (char_length(category) <= 40),
  recurrence       text not null default 'none'
                   check (recurrence in ('none', 'daily', 'weekdays', 'weekly', 'monthly')),
  parent_id        uuid references public.tasks (id) on delete cascade,
  estimate_minutes int check (estimate_minutes between 1 and 1440),
  assigned         boolean not null default false,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index tasks_user_due_idx on public.tasks (user_id, due_on);
create index tasks_user_status_idx on public.tasks (user_id, status);
create index tasks_parent_idx on public.tasks (parent_id);

create function private.next_task_date(p_from date, p_recurrence text)
returns date
language sql
immutable
set search_path = ''
as $$
  select case p_recurrence
    when 'daily'    then p_from + 1
    when 'weekly'   then p_from + 7
    when 'monthly'  then (p_from + interval '1 month')::date
    when 'weekdays' then p_from + case extract(dow from p_from)::int when 5 then 3 when 6 then 2 else 1 end
  end;
$$;

-- Stamps the completion time, and rolls recurring tasks forward when one is finished.
create function private.task_status_changed()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'done' and old.status is distinct from 'done' then
    new.completed_at := coalesce(new.completed_at, now());
    if new.recurrence <> 'none' then
      insert into public.tasks
        (user_id, title, notes, priority, due_on, due_time, category, recurrence, estimate_minutes, assigned)
      values
        (new.user_id, new.title, new.notes, new.priority,
         private.next_task_date(greatest(coalesce(new.due_on, private.today()), private.today()), new.recurrence),
         new.due_time, new.category, new.recurrence, new.estimate_minutes, new.assigned);
      -- The finished copy is now history; only its successor keeps repeating.
      new.recurrence := 'none';
    end if;
  elsif new.status <> 'done' and old.status = 'done' then
    new.completed_at := null;
  end if;
  return new;
end;
$$;

create trigger tasks_status_changed
  before update of status on public.tasks
  for each row execute function private.task_status_changed();

create function private.task_inserted_done()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'done' then
    new.completed_at := coalesce(new.completed_at, now());
  end if;
  return new;
end;
$$;

create trigger tasks_inserted_done
  before insert on public.tasks
  for each row execute function private.task_inserted_done();

alter table public.tasks enable row level security;
create policy "Own rows after the gate" on public.tasks for all to authenticated
  using (user_id = (select auth.uid()) and (select private.gate_ok()))
  with check (user_id = (select auth.uid()) and (select private.gate_ok()));
create trigger tasks_set_updated_at before update on public.tasks
  for each row execute function private.set_updated_at();
revoke all on public.tasks from anon;
