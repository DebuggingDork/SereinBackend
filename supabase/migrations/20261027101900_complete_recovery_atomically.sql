-- Finishing a recovery took two separate writes: close the request, then swap the
-- questions. A failure between them spent the request and left the old questions in
-- place. One function now does both, and it checks the state itself, so a denial or
-- expiry that lands at the last moment still wins.
create function public.complete_recovery(p_user_id uuid, p_questions jsonb)
returns boolean
language plpgsql
set search_path = ''
as $$
begin
  update public.recovery_requests
     set status = 'completed', completed_at = now()
   where user_id = p_user_id
     and status = 'ready'
     and ready_at <= now()
     and approved_at is not null
     and requested_at >= now() - interval '24 hours';
  if not found then
    return false;
  end if;

  perform public.replace_security_questions(p_user_id, p_questions);
  return true;
end;
$$;

revoke execute on function public.complete_recovery(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.complete_recovery(uuid, jsonb) to service_role;
