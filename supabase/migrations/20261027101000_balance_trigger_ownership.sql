-- The balance trigger has to work whoever fires it, including the auth service when
-- a deleted user's transactions cascade away. So it now runs with the owner's rights
-- and enforces ownership itself: a balance only moves when the account belongs to the
-- same user as the transaction, and writing a transaction against someone else's
-- account is refused rather than silently stored.

drop function private.move_balance(uuid, numeric);

create function private.move_balance(p_user_id uuid, p_account_id uuid, p_delta numeric)
returns boolean
language plpgsql
set search_path = ''
as $$
begin
  update public.accounts
     set balance = balance + case when kind = 'card' then -p_delta else p_delta end
   where id = p_account_id and user_id = p_user_id;
  return found;
end;
$$;
revoke execute on function private.move_balance(uuid, uuid, numeric) from public;

create or replace function private.apply_transaction()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Undoing needs no check: during a cascade the account may already be gone.
  if tg_op in ('UPDATE', 'DELETE') then
    if old.kind = 'income' then
      perform private.move_balance(old.user_id, old.account_id, -old.amount);
    elsif old.kind = 'expense' then
      perform private.move_balance(old.user_id, old.account_id, old.amount);
    else
      perform private.move_balance(old.user_id, old.account_id, old.amount);
      perform private.move_balance(old.user_id, old.to_account_id, -old.amount);
    end if;
  end if;

  if tg_op in ('INSERT', 'UPDATE') then
    if new.kind = 'income' then
      if not private.move_balance(new.user_id, new.account_id, new.amount) then
        raise exception 'Account not found' using errcode = '23503';
      end if;
    elsif new.kind = 'expense' then
      if not private.move_balance(new.user_id, new.account_id, -new.amount) then
        raise exception 'Account not found' using errcode = '23503';
      end if;
    else
      if not private.move_balance(new.user_id, new.account_id, -new.amount)
         or not private.move_balance(new.user_id, new.to_account_id, new.amount) then
        raise exception 'Account not found' using errcode = '23503';
      end if;
    end if;
  end if;

  return null;
end;
$$;
