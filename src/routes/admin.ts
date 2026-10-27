import { Router } from 'express';
import { z } from 'zod';
import { HttpError, must } from '../lib/errors.js';
import { db } from '../lib/supabase.js';
import { requireAdmin, requirePass } from '../middleware/auth.js';
import { addressLimiter, limiter } from '../middleware/common.js';
import { approve, deny } from '../services/recovery.js';

export const adminRouter = Router();

// Admins pass their own gate like everyone else. Everyone else gets a plain 404.
adminRouter.use(addressLimiter(), requireAdmin, requirePass, limiter(5, 300));

interface DirectoryEntry {
  id: string;
  email: string;
  confirmed: boolean;
  last_sign_in: string | null;
  created_at: string;
  display_name: string;
  role: string;
  onboarded_at: string | null;
}

async function directory(ids?: string[]): Promise<DirectoryEntry[]> {
  return must(await db.rpc('admin_user_directory', ids ? { p_ids: [...new Set(ids)] } : {})) as DirectoryEntry[];
}

async function emailsFor(ids: string[]): Promise<Map<string, string>> {
  const entries = ids.length > 0 ? await directory(ids) : [];
  return new Map(entries.map((entry) => [entry.id, entry.email]));
}

function requestId(value: unknown): string {
  const parsed = z.uuid().safeParse(value);
  if (!parsed.success) throw new HttpError(404, 'Request not found.');
  return parsed.data;
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
  const emails = await emailsFor(rows.map((row) => row.user_id));
  res.json({
    requests: rows.map(({ user_id, ...row }) => ({ ...row, email: emails.get(user_id) ?? 'Unknown' })),
  });
});

adminRouter.post('/recovery/:id/approve', async (req, res) => {
  await approve(requestId(req.params.id));
  res.json({ ok: true });
});

adminRouter.post('/recovery/:id/deny', async (req, res) => {
  await deny(requestId(req.params.id));
  res.json({ ok: true });
});

adminRouter.get('/users', async (_req, res) => {
  const entries = await directory();
  res.json({
    users: entries.map((entry) => ({
      id: entry.id,
      display_name: entry.display_name,
      role: entry.role,
      onboarded_at: entry.onboarded_at,
      email: entry.email,
      confirmed: entry.confirmed,
      lastSignIn: entry.last_sign_in,
      createdAt: entry.created_at,
    })),
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
  const emails = await emailsFor(rows.map((row) => row.user_id));
  res.json({
    attempts: rows.map(({ user_id, ...row }) => ({ ...row, email: emails.get(user_id) ?? 'Unknown' })),
  });
});
