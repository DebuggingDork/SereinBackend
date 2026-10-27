-- Diary: dated entries with mood, tags and full-text search.

create table public.diary_entries (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  entry_on   date not null default private.today(),
  title      text not null default '' check (char_length(title) <= 160),
  body       text not null default '' check (char_length(body) <= 50000),
  mood       text check (mood in ('bright', 'settled', 'restless', 'tired', 'low')),
  tags       text[] not null default '{}',
  search     tsvector generated always as (
    setweight(to_tsvector('english', title), 'A') || setweight(to_tsvector('english', body), 'B')
  ) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index diary_entries_user_date_idx on public.diary_entries (user_id, entry_on desc);
create index diary_entries_search_idx on public.diary_entries using gin (search);

alter table public.diary_entries enable row level security;
create policy "Own rows after the gate" on public.diary_entries for all to authenticated
  using (user_id = (select auth.uid()) and (select private.gate_ok()))
  with check (user_id = (select auth.uid()) and (select private.gate_ok()));
create trigger diary_entries_set_updated_at before update on public.diary_entries
  for each row execute function private.set_updated_at();
revoke all on public.diary_entries from anon;

create function public.search_diary(p_query text)
returns table (id uuid, entry_on date, title text, mood text, snippet text, rank real)
language sql
stable
set search_path = ''
as $$
  select
    e.id,
    e.entry_on,
    e.title,
    e.mood,
    pg_catalog.ts_headline(
      'english', e.body, q,
      'StartSel=<mark>, StopSel=</mark>, MaxFragments=2, MaxWords=24, MinWords=8'
    ),
    pg_catalog.ts_rank(e.search, q)
  from public.diary_entries e,
       pg_catalog.websearch_to_tsquery('english', p_query) q
  where e.search @@ q
  order by 6 desc, e.entry_on desc
  limit 50;
$$;
