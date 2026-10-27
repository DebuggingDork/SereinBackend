-- Scheduled work runs inside Postgres, so it keeps running while the free-tier
-- backend sleeps and needs no extra service.

create extension if not exists pg_cron;

-- Posts every due automatic item, catching up on anything missed.
create function private.run_scheduled_items()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  item public.scheduled_items;
  local_today date;
begin
  for item in
    select s.* from public.scheduled_items s
    where s.active and s.auto_post and s.next_run <= now()::date + 1
    for update
  loop
    local_today := (now() at time zone coalesce(
      (select p.preferences ->> 'timezone' from public.profiles p where p.id = item.user_id),
      'Asia/Kolkata'
    ))::date;

    while item.next_run <= local_today loop
      insert into public.transactions
        (user_id, kind, amount, category_id, account_id, payment_app, occurred_on, payee, notes)
      values
        (item.user_id, item.kind, item.amount, item.category_id, item.account_id, item.payment_app,
         item.next_run, coalesce(item.payee, item.name), 'Scheduled');

      item.next_run := private.next_occurrence(item.next_run, item.frequency, item.interval_days);
    end loop;

    update public.scheduled_items set next_run = item.next_run where id = item.id;
  end loop;
end;
$$;

-- Records everyone's net worth for the day so the trend has daily history.
create function private.capture_all_net_worth()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.net_worth_snapshots (user_id, taken_on, assets, liabilities)
  select
    p.id,
    (now() at time zone coalesce(p.preferences ->> 'timezone', 'Asia/Kolkata'))::date,
    coalesce((select sum(a.balance) from public.accounts a
              where a.user_id = p.id and not a.hidden and a.kind <> 'card'), 0)
      + coalesce((select sum(d.remaining) from public.debt_balances d
                  where d.user_id = p.id and d.direction = 'lent'), 0),
    coalesce((select sum(a.balance) from public.accounts a
              where a.user_id = p.id and not a.hidden and a.kind = 'card'), 0)
      + coalesce((select sum(d.remaining) from public.debt_balances d
                  where d.user_id = p.id and d.direction = 'borrowed'), 0)
  from public.profiles p
  on conflict (user_id, taken_on) do update
    set assets = excluded.assets, liabilities = excluded.liabilities;
end;
$$;

select cron.schedule('serein-recovery-tick', '*/5 * * * *', 'select public.recovery_tick()');
select cron.schedule('serein-gate-cleanup', '30 3 * * *', 'select public.gate_cleanup()');
-- 00:30 and 18:30 UTC, so morning in India and any western timezone both get a pass.
select cron.schedule('serein-scheduled-items', '30 0,18 * * *', 'select private.run_scheduled_items()');
select cron.schedule('serein-net-worth', '45 18 * * *', 'select private.capture_all_net_worth()');
