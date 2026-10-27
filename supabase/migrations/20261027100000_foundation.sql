-- Foundation: helper schema, shared triggers and user profiles.

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated, service_role;

create function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Serein never stores card or account numbers. Twelve or more digits in a row,
-- with optional spaces or dashes between them, is treated as one.
create function private.has_long_number(value text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(value ~ '([0-9][ -]?){12,}', false);
$$;

create table public.profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  display_name  text not null default '' check (char_length(display_name) <= 80),
  role          text not null default 'user' check (role in ('user', 'admin')),
  preferences   jsonb not null default '{
    "currency": "INR",
    "weekStart": 1,
    "monthStart": 1,
    "salaryDay": 1,
    "timezone": "Asia/Kolkata"
  }'::jsonb,
  home_layout   jsonb,
  gate_required boolean not null default true,
  onboarded_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function private.set_updated_at();

-- The user's local calendar date, used by every "today" query.
create function private.today()
returns date
language sql
stable
security definer
set search_path = ''
as $$
  select (now() at time zone coalesce(
    (select p.preferences ->> 'timezone' from public.profiles p where p.id = auth.uid()),
    'Asia/Kolkata'
  ))::date;
$$;

create function private.preference_int(key text, fallback int)
returns int
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select (p.preferences ->> key)::int from public.profiles p where p.id = auth.uid()),
    fallback
  );
$$;

grant execute on function private.today() to authenticated;
grant execute on function private.preference_int(text, int) to authenticated;
grant execute on function private.has_long_number(text) to authenticated, service_role;

create function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'name', ''));
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();
