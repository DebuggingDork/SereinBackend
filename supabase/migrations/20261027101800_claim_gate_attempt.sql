-- The cooldown was read before the slow hash comparison and only recorded after it, so
-- parallel requests all passed the check and all guessed at the same question. A guess
-- now has to claim the session's single slot first. The claim expires by itself, so a
-- crash in the middle cannot leave anyone locked out.

alter table public.gate_state add column verifying_until timestamptz;

create function public.gate_claim_attempt(p_user_id uuid)
returns table (claimed boolean, current_question_id uuid, failed_count int, locked_until timestamptz)
language plpgsql
set search_path = ''
as $$
begin
  return query
    update public.gate_state gs
       set verifying_until = now() + interval '5 seconds'
     where gs.user_id = p_user_id
       and (gs.locked_until is null or gs.locked_until <= now())
       and (gs.verifying_until is null or gs.verifying_until <= now())
    returning true, gs.current_question_id, gs.failed_count, gs.locked_until;
  if found then
    return;
  end if;

  return query
    select false, gs.current_question_id, gs.failed_count, gs.locked_until
    from public.gate_state gs
    where gs.user_id = p_user_id;
end;
$$;

revoke execute on function public.gate_claim_attempt(uuid) from public, anon, authenticated;
grant execute on function public.gate_claim_attempt(uuid) to service_role;

create or replace function public.gate_register_failure(p_user_id uuid)
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
        last_failed_at = now(),
        verifying_until = null
  returning gs.failed_count into next_count;

  if next_count >= 4 then
    next_lock := now() + waits[least(next_count - 3, 4)];
    update public.gate_state gs set locked_until = next_lock where gs.user_id = p_user_id;
  end if;

  return query select next_count, next_lock;
end;
$$;
