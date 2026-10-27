-- The rotating security gate and delayed recovery.
--
-- Nothing here is reachable with a browser key: tables have row-level security
-- with no policies, and only the backend's service role may touch them.

create table public.security_questions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  question      text not null check (char_length(question) between 3 and 200),
  answer_hash   text not null,
  last_asked_at timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index security_questions_user_id_idx on public.security_questions (user_id);

create trigger security_questions_set_updated_at
  before update on public.security_questions
  for each row execute function private.set_updated_at();

-- Enforces the 1 to 10 question limit however rows arrive.
create function private.limit_security_questions()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (select count(*) from public.security_questions where user_id = new.user_id) >= 10 then
    raise exception 'A maximum of 10 security questions is allowed';
  end if;
  return new;
end;
$$;

create trigger security_questions_limit
  before insert on public.security_questions
  for each row execute function private.limit_security_questions();

-- Which question is on the table and how close the user is to a cooldown. The
-- server remembers the question so a client cannot shop for an easier one.
create table public.gate_state (
  user_id             uuid primary key references auth.users (id) on delete cascade,
  current_question_id uuid references public.security_questions (id) on delete set null,
  failed_count        int not null default 0,
  last_failed_at      timestamptz,
  locked_until        timestamptz,
  updated_at          timestamptz not null default now()
);

create trigger gate_state_set_updated_at
  before update on public.gate_state
  for each row execute function private.set_updated_at();

create table public.gate_attempts (
  id             bigint generated always as identity primary key,
  user_id        uuid not null references auth.users (id) on delete cascade,
  success        boolean not null,
  ip             text,
  question_id    uuid references public.security_questions (id) on delete set null,
  question_text  text,
  created_at     timestamptz not null default now()
);
create index gate_attempts_user_created_idx on public.gate_attempts (user_id, created_at desc);
create index gate_attempts_created_idx on public.gate_attempts (created_at desc);

-- One row per Supabase auth session that has passed the gate. Row-level security
-- on every data table checks this, so the gate holds even against direct API calls.
create table public.gate_sessions (
  session_id uuid primary key,
  user_id    uuid not null references auth.users (id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index gate_sessions_user_id_idx on public.gate_sessions (user_id);

create table public.recovery_requests (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  kind         text not null check (kind in ('normal', 'super')),
  status       text not null default 'pending'
               check (status in ('pending', 'approved', 'ready', 'completed', 'expired', 'denied')),
  requested_at timestamptz not null default now(),
  ready_at     timestamptz not null,
  approved_at  timestamptz,
  denied_at    timestamptz,
  completed_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create unique index recovery_requests_one_open_idx
  on public.recovery_requests (user_id)
  where status in ('pending', 'approved', 'ready');
create index recovery_requests_status_idx on public.recovery_requests (status, requested_at desc);

create trigger recovery_requests_set_updated_at
  before update on public.recovery_requests
  for each row execute function private.set_updated_at();

alter table public.security_questions enable row level security;
alter table public.gate_state         enable row level security;
alter table public.gate_attempts      enable row level security;
alter table public.gate_sessions      enable row level security;
alter table public.recovery_requests  enable row level security;

revoke all on public.security_questions, public.gate_state, public.gate_attempts,
              public.gate_sessions, public.recovery_requests
  from anon, authenticated;

-- True when the session behind the current request has a live gate pass.
create function private.gate_ok()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.gate_sessions s
    where s.session_id = nullif(auth.jwt() ->> 'session_id', '')::uuid
      and s.user_id = auth.uid()
      and s.expires_at > now()
  );
$$;
grant execute on function private.gate_ok() to authenticated;

-- Profiles are readable before the gate so the app can route the user, but only
-- a few columns can be written, and only after it. Role is never client-writable.
alter table public.profiles enable row level security;

create policy "Users read their own profile"
  on public.profiles for select to authenticated
  using (id = (select auth.uid()));

create policy "Users update their own profile after the gate"
  on public.profiles for update to authenticated
  using (id = (select auth.uid()) and (select private.gate_ok()))
  with check (id = (select auth.uid()));

revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;
grant update (display_name, preferences, home_layout, onboarded_at) on public.profiles to authenticated;

-- Records a wrong answer atomically and returns the resulting cooldown. The first
-- three misses only roast; from the fourth on the wait grows 30s, 2m, 10m, 1h.
create function public.gate_register_failure(p_user_id uuid)
returns table (failed_count int, locked_until timestamptz)
language plpgsql
set search_path = ''
as $$
declare
  waits constant interval[] := array['30 seconds', '2 minutes', '10 minutes', '1 hour']::interval[];
  next_count int;
  next_lock  timestamptz;
begin
  insert into public.gate_state as gs (user_id, failed_count, last_failed_at)
  values (p_user_id, 1, now())
  on conflict (user_id) do update
    set failed_count = case
          when gs.last_failed_at < now() - interval '24 hours' then 1
          else gs.failed_count + 1
        end,
        last_failed_at = now()
  returning gs.failed_count into next_count;

  if next_count >= 4 then
    next_lock := now() + waits[least(next_count - 3, 4)];
    update public.gate_state gs set locked_until = next_lock where gs.user_id = p_user_id;
  end if;

  return query select next_count, next_lock;
end;
$$;

-- Moves approved requests to ready once the wait has passed and expires anything
-- older than a day. Run on a schedule, and by the backend before it reads a request.
create function public.recovery_tick()
returns void
language sql
set search_path = ''
as $$
  update public.recovery_requests
     set status = 'expired'
   where status in ('pending', 'approved', 'ready')
     and requested_at < now() - interval '24 hours';

  update public.recovery_requests
     set status = 'ready'
   where status = 'approved'
     and ready_at <= now();
$$;

create function public.gate_cleanup()
returns void
language sql
set search_path = ''
as $$
  delete from public.gate_attempts where created_at < now() - interval '90 days';
  delete from public.gate_sessions where expires_at < now();
$$;

revoke execute on function public.gate_register_failure(uuid) from public, anon, authenticated;
revoke execute on function public.recovery_tick() from public, anon, authenticated;
revoke execute on function public.gate_cleanup() from public, anon, authenticated;
grant execute on function public.gate_register_failure(uuid) to service_role;
grant execute on function public.recovery_tick() to service_role;
grant execute on function public.gate_cleanup() to service_role;
