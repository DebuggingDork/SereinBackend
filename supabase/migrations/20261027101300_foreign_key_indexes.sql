-- The two foreign keys whose missing index measurably cost something. The others still
-- without one sit on tables holding a handful of rows per user.
--
-- Deleting a transaction scanned debt_payments: 157 ms of a 20,000-transaction user
-- delete, now 85 ms. Replacing security questions scanned the shared attempt log: 10 ms
-- per question at 200,000 attempts, now 0.5 ms, and it would have grown with every user. Most rows in both are null, so
-- partial indexes keep the write cost close to nothing.
create index debt_payments_transaction_idx on public.debt_payments (transaction_id)
  where transaction_id is not null;
create index gate_attempts_question_idx on public.gate_attempts (question_id)
  where question_id is not null;
