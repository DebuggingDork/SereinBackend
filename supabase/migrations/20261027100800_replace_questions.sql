-- Swaps a user's whole question set atomically. Only the question set changes:
-- the user id, and everything hanging off it, stays exactly as it was.
create function public.replace_security_questions(p_user_id uuid, p_questions jsonb)
returns void
language plpgsql
set search_path = ''
as $$
begin
  delete from public.security_questions where user_id = p_user_id;

  insert into public.security_questions (user_id, question, answer_hash)
  select p_user_id, q ->> 'question', q ->> 'answer_hash'
  from jsonb_array_elements(p_questions) q;

  insert into public.gate_state as gs (user_id)
  values (p_user_id)
  on conflict (user_id) do update
    set failed_count = 0, locked_until = null, last_failed_at = null;
end;
$$;

revoke execute on function public.replace_security_questions(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.replace_security_questions(uuid, jsonb) to service_role;
