import { Router } from 'express';
import { must } from '../lib/errors.js';
import { db } from '../lib/supabase.js';
import { requireAdmin, requireAuth, requirePass } from '../middleware/auth.js';
import { limiter } from '../middleware/common.js';
import { approve, deny } from '../services/recovery.js';

export const adminRouter = Router();

// Admins pass their own gate like everyone else. Non-admins get a plain 404.
adminRouter.use(requireAuth, requirePass, requireAdmin, limiter(5, 300));

async function emailsById(): Promise<Map<string, { email: string; confirmed: boolean; lastSignIn: string | null; createdAt: string }>> {
  const { data, error } = await db.auth.admin.listUsers({ perPage: 1000 });
  if (error) throw new Error(error.message);
  return new Map(
    data.users.map((user) => [
      user.id,
      {
        email: user.email ?? '',
        confirmed: Boolean(user.email_confirmed_at),
        lastSignIn: user.last_sign_in_at ?? null,
        createdAt: user.created_at,
      },
    ]),
  );
}

adminRouter.get('/recovery', async (_req, res) => {
  must(await db.rpc('recovery_tick'));
  const rows = must(
    await db
      .from('recovery_requests')
      .select('id, user_id, kind, status, requested_at, ready_at, approved_at, denied_at, completed_at')
      .order('requested_at', { ascending: false })
      .limit(200),
  );
  const users = await emailsById();
  res.json({
    requests: rows.map(({ user_id, ...row }) => ({ ...row, email: users.get(user_id)?.email ?? 'Unknown' })),
  });
});

adminRouter.post('/recovery/:id/approve', async (req, res) => {
  await approve(req.params.id as string);
  res.json({ ok: true });
});

adminRouter.post('/recovery/:id/deny', async (req, res) => {
  await deny(req.params.id as string);
  res.json({ ok: true });
});

adminRouter.get('/users', async (_req, res) => {
  const users = await emailsById();
  const profiles = must(await db.from('profiles').select('id, display_name, role, onboarded_at'));
  res.json({
    users: profiles.map((profile) => ({ ...profile, ...users.get(profile.id) })),
  });
});

adminRouter.get('/security-log', async (req, res) => {
  const outcome = req.query.outcome;
  let query = db
    .from('gate_attempts')
    .select('id, user_id, success, ip, question_text, created_at')
    .order('created_at', { ascending: false })
    .limit(200);
  if (outcome === 'failed') query = query.eq('success', false);
  if (outcome === 'passed') query = query.eq('success', true);

  const rows = must(await query);
  const users = await emailsById();
  res.json({
    attempts: rows.map(({ user_id, ...row }) => ({ ...row, email: users.get(user_id)?.email ?? 'Unknown' })),
  });
});
