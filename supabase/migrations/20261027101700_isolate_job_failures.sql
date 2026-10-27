-- One user's row could stop the nightly jobs for everyone, because a single error
-- aborted the whole run, every run. Each item and each person now fails alone, leaves a
-- warning in the Postgres log, and is tried again next time.

-- At most this many postings per item per run, so a next_run set centuries back cannot
-- flood the table. A longer gap keeps catching up on later runs.
create or replace function private.run_scheduled_items()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  item public.scheduled_items;
  local_today date;
  posted int;
begin
  for item in
    select s.* from public.scheduled_items s
    where s.active and s.auto_post and s.next_run <= now()::date + 1
    for update
  loop
    begin
      local_today := (now() at time zone private.safe_timezone(
        (select p.preferences ->> 'timezone' from public.profiles p where p.id = item.user_id)
      ))::date;

      posted := 0;
      while item.next_run <= local_today and posted < 366 loop
        insert into public.transactions
          (user_id, kind, amount, category_id, account_id, payment_app, occurred_on, payee, notes)
        values
          (item.user_id, item.kind, item.amount, item.category_id, item.account_id, item.payment_app,
           item.next_run, coalesce(item.payee, item.name), 'Scheduled');

        item.next_run := private.next_occurrence(item.next_run, item.frequency, item.interval_days);
        posted := posted + 1;
      end loop;

      update public.scheduled_items set next_run = item.next_run where id = item.id;
    exception when others then
      raise warning 'scheduled item % skipped: %', item.id, sqlerrm;
    end;
  end loop;
end;
$$;

create or replace function private.capture_all_net_worth()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  person record;
begin
  for person in select p.id, p.preferences ->> 'timezone' as timezone from public.profiles p loop
    begin
      insert into public.net_worth_snapshots (user_id, taken_on, assets, liabilities)
      select
        person.id,
        (now() at time zone private.safe_timezone(person.timezone))::date,
        coalesce((select sum(a.balance) from public.accounts a
                  where a.user_id = person.id and not a.hidden and a.kind <> 'card'), 0)
          + coalesce((select sum(d.remaining) from public.debt_balances d
                      where d.user_id = person.id and d.direction = 'lent'), 0),
        coalesce((select sum(a.balance) from public.accounts a
                  where a.user_id = person.id and not a.hidden and a.kind = 'card'), 0)
          + coalesce((select sum(d.remaining) from public.debt_balances d
                      where d.user_id = person.id and d.direction = 'borrowed'), 0)
      on conflict (user_id, taken_on) do update
        set assets = excluded.assets, liabilities = excluded.liabilities;
    exception when others then
      raise warning 'net worth snapshot skipped for %: %', person.id, sqlerrm;
    end;
  end loop;
end;
$$;
