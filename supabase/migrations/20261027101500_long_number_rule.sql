-- The long number rule let 4111.1111.1111.1111 through, because only spaces and dashes
-- counted as separators. Any single non-alphanumeric character now does. Dates and times
-- are removed first, so "2026-10-27 12:30:00" in a note is not mistaken for a card.
-- src/lib/longNumber.ts and the frontend's lib/guards.ts mirror this.
create or replace function private.has_long_number(value text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    pg_catalog.regexp_replace(
      value,
      '(?<![0-9])((19|20)[0-9]{2}[-/.](0?[1-9]|1[0-2])[-/.](0?[1-9]|[12][0-9]|3[01])|(0?[1-9]|[12][0-9]|3[01])[-/.](0?[1-9]|1[0-2])[-/.](19|20)[0-9]{2}|[0-9]{1,2}:[0-9]{2}(:[0-9]{2})?)(?![0-9])',
      ' ',
      'g'
    ) ~ '([0-9][^0-9a-zA-Z]?){12,}',
    false
  );
$$;

-- Plan section 5: every field that looks like a long number is rejected. Diary titles
-- and bodies are left out on purpose: a journal is free writing, autosaved as it is typed,
-- and refusing a save because of a phone number would lose the user's words.
--
-- NOT VALID applies the rule to new and changed rows without failing on old ones.
alter table public.categories
  add constraint categories_name_no_long_number check (not private.has_long_number(name)) not valid;
alter table public.transactions
  add constraint transactions_payment_app_no_long_number check (not private.has_long_number(payment_app)) not valid;
alter table public.transaction_templates
  add constraint transaction_templates_name_no_long_number check (not private.has_long_number(name)) not valid,
  add constraint transaction_templates_payment_app_no_long_number check (not private.has_long_number(payment_app)) not valid;
alter table public.scheduled_items
  add constraint scheduled_items_name_no_long_number check (not private.has_long_number(name)) not valid,
  add constraint scheduled_items_payment_app_no_long_number check (not private.has_long_number(payment_app)) not valid;
alter table public.people
  add constraint people_name_no_long_number check (not private.has_long_number(name)) not valid;
alter table public.goals
  add constraint goals_name_no_long_number check (not private.has_long_number(name)) not valid;
alter table public.tasks
  add constraint tasks_title_no_long_number check (not private.has_long_number(title)) not valid,
  add constraint tasks_notes_no_long_number check (not private.has_long_number(notes)) not valid;
alter table public.foods
  add constraint foods_name_no_long_number check (not private.has_long_number(name)) not valid,
  add constraint foods_serving_no_long_number check (not private.has_long_number(serving)) not valid;
alter table public.meal_logs
  add constraint meal_logs_name_no_long_number check (not private.has_long_number(name)) not valid;
alter table public.meal_plans
  add constraint meal_plans_items_no_long_number check (not private.has_long_number(items)) not valid;
alter table public.security_questions
  add constraint security_questions_question_no_long_number check (not private.has_long_number(question)) not valid;
alter table public.profiles
  add constraint profiles_display_name_no_long_number check (not private.has_long_number(display_name)) not valid;

-- A name from the signup form must never be able to fail the signup, so one the profile
-- would refuse is shortened or dropped. It can be set again later from the profile page.
create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  given text := left(coalesce(new.raw_user_meta_data ->> 'name', ''), 80);
begin
  insert into public.profiles (id, display_name)
  values (new.id, case when private.has_long_number(given) then '' else given end);
  return new;
end;
$$;
