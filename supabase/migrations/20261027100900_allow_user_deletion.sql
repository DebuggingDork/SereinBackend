-- RESTRICT fires as soon as an account row is touched, which blocked deleting a user:
-- the cascade reached accounts before transactions. NO ACTION waits until the end of
-- the statement, so a whole-user delete succeeds, while deleting a single account that
-- still has transactions is refused exactly as before.
alter table public.transactions
  drop constraint transactions_account_id_fkey,
  add constraint transactions_account_id_fkey
    foreign key (account_id) references public.accounts (id) on delete no action;

alter table public.transactions
  drop constraint transactions_to_account_id_fkey,
  add constraint transactions_to_account_id_fkey
    foreign key (to_account_id) references public.accounts (id) on delete no action;
