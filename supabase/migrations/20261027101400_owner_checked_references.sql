-- Row-level security does not apply to foreign key checks, so a user who knew another
-- user's row id could point their own rows at it: paying down someone else's debt,
-- filing under their category, scheduling against their account. Each reference now
-- includes user_id, so the database refuses anything that crosses between two people.
--
-- NOT VALID enforces this on every new or changed row without failing the push if an
-- old row already breaks it. ON DELETE SET NULL (column) needs Postgres 15 or later.

alter table public.accounts     add constraint accounts_id_user_id_key     unique (id, user_id);
alter table public.categories   add constraint categories_id_user_id_key   unique (id, user_id);
alter table public.people       add constraint people_id_user_id_key       unique (id, user_id);
alter table public.debts        add constraint debts_id_user_id_key        unique (id, user_id);
alter table public.transactions add constraint transactions_id_user_id_key unique (id, user_id);
alter table public.tasks        add constraint tasks_id_user_id_key        unique (id, user_id);
alter table public.foods        add constraint foods_id_user_id_key        unique (id, user_id);

alter table public.categories
  drop constraint categories_parent_id_fkey,
  add constraint categories_parent_id_fkey foreign key (parent_id, user_id)
    references public.categories (id, user_id) on delete set null (parent_id) not valid;

alter table public.transactions
  drop constraint transactions_category_id_fkey,
  add constraint transactions_category_id_fkey foreign key (category_id, user_id)
    references public.categories (id, user_id) on delete set null (category_id) not valid;

-- These keep NO ACTION: an account that still has transactions cannot be deleted.
alter table public.transactions
  drop constraint transactions_account_id_fkey,
  add constraint transactions_account_id_fkey foreign key (account_id, user_id)
    references public.accounts (id, user_id) on delete no action not valid;

alter table public.transactions
  drop constraint transactions_to_account_id_fkey,
  add constraint transactions_to_account_id_fkey foreign key (to_account_id, user_id)
    references public.accounts (id, user_id) on delete no action not valid;

alter table public.transaction_templates
  drop constraint transaction_templates_category_id_fkey,
  add constraint transaction_templates_category_id_fkey foreign key (category_id, user_id)
    references public.categories (id, user_id) on delete set null (category_id) not valid;

alter table public.transaction_templates
  drop constraint transaction_templates_account_id_fkey,
  add constraint transaction_templates_account_id_fkey foreign key (account_id, user_id)
    references public.accounts (id, user_id) on delete set null (account_id) not valid;

alter table public.budgets
  drop constraint budgets_category_id_fkey,
  add constraint budgets_category_id_fkey foreign key (category_id, user_id)
    references public.categories (id, user_id) on delete cascade not valid;

alter table public.scheduled_items
  drop constraint scheduled_items_category_id_fkey,
  add constraint scheduled_items_category_id_fkey foreign key (category_id, user_id)
    references public.categories (id, user_id) on delete set null (category_id) not valid;

alter table public.scheduled_items
  drop constraint scheduled_items_account_id_fkey,
  add constraint scheduled_items_account_id_fkey foreign key (account_id, user_id)
    references public.accounts (id, user_id) on delete cascade not valid;

alter table public.debts
  drop constraint debts_person_id_fkey,
  add constraint debts_person_id_fkey foreign key (person_id, user_id)
    references public.people (id, user_id) on delete cascade not valid;

alter table public.debt_payments
  drop constraint debt_payments_debt_id_fkey,
  add constraint debt_payments_debt_id_fkey foreign key (debt_id, user_id)
    references public.debts (id, user_id) on delete cascade not valid;

alter table public.debt_payments
  drop constraint debt_payments_transaction_id_fkey,
  add constraint debt_payments_transaction_id_fkey foreign key (transaction_id, user_id)
    references public.transactions (id, user_id) on delete set null (transaction_id) not valid;

alter table public.goals
  drop constraint goals_account_id_fkey,
  add constraint goals_account_id_fkey foreign key (account_id, user_id)
    references public.accounts (id, user_id) on delete set null (account_id) not valid;

alter table public.tasks
  drop constraint tasks_parent_id_fkey,
  add constraint tasks_parent_id_fkey foreign key (parent_id, user_id)
    references public.tasks (id, user_id) on delete cascade not valid;

alter table public.meal_logs
  drop constraint meal_logs_food_id_fkey,
  add constraint meal_logs_food_id_fkey foreign key (food_id, user_id)
    references public.foods (id, user_id) on delete set null (food_id) not valid;
