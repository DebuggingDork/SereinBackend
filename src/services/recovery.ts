import { env } from '../config/env.js';
import { sendMail } from '../lib/email.js';
import { HttpError, must } from '../lib/errors.js';
import { db } from '../lib/supabase.js';

export const WAIT_MINUTES = { normal: 90, super: 20 } as const;
export type RecoveryKind = keyof typeof WAIT_MINUTES;

const EMAIL_PROOF_MAX_AGE_SECONDS = 20 * 60;
const EMAIL_PROOF_METHODS = new Set(['otp', 'magiclink', 'email/signup', 'recovery']);

// True when this session was created from an email link in the last few minutes.
export function hasRecentEmailProof(amr: { method: string; timestamp: number }[], now = Date.now()): boolean {
  return amr.some(
    ({ method, timestamp }) =>
      EMAIL_PROOF_METHODS.has(method) && now / 1000 - timestamp <= EMAIL_PROOF_MAX_AGE_SECONDS,
  );
}

interface RecoveryRow {
  id: string;
  kind: RecoveryKind;
  status: string;
  requested_at: string;
  ready_at: string;
}

// What the user is allowed to know. Approval is invisible: a request simply stays
// "waiting" until it has been approved and its time has passed.
export function publicView(row: RecoveryRow | null) {
  if (!row) return { state: 'none' as const };
  const base = { kind: row.kind, requestedAt: row.requested_at, readyAt: row.ready_at };
  switch (row.status) {
    case 'ready':
      return { ...base, state: 'ready' as const };
    case 'denied':
      return { ...base, state: 'denied' as const };
    case 'expired':
      return { ...base, state: 'expired' as const };
    case 'completed':
      return { state: 'none' as const };
    default:
      return { ...base, state: 'waiting' as const };
  }
}

async function latestFor(userId: string): Promise<RecoveryRow | null> {
  must(await db.rpc('recovery_tick'));
  return must(
    await db
      .from('recovery_requests')
      .select('id, kind, status, requested_at, ready_at')
      .eq('user_id', userId)
      .order('requested_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ) as RecoveryRow | null;
}

export async function getCurrent(userId: string) {
  return publicView(await latestFor(userId));
}

export async function createRequest(userId: string, email: string, kind: RecoveryKind) {
  const latest = await latestFor(userId);
  if (latest && ['pending', 'approved', 'ready'].includes(latest.status)) {
    return publicView(latest);
  }

  const minutes = WAIT_MINUTES[kind];
  const row = must(
    await db
      .from('recovery_requests')
      .insert({
        user_id: userId,
        kind,
        ready_at: new Date(Date.now() + minutes * 60 * 1000).toISOString(),
      })
      .select('id, kind, status, requested_at, ready_at')
      .single(),
  ) as RecoveryRow;

  // Telling the real owner at once is what stops a quiet takeover.
  await sendMail({
    to: email,
    subject: 'A request to reset your Serein questions',
    text: [
      `Someone, hopefully you, asked to reset the security questions on your Serein account. You will be able to set new ones in about ${minutes} minutes.`,
      'If this was not you, change your Serein password now and reply to this email.',
    ].join('\n\n'),
  });

  if (env.OWNER_NOTIFY_EMAIL) {
    await sendMail({
      to: env.OWNER_NOTIFY_EMAIL,
      subject: `Recovery request (${kind})`,
      text: `${email} has requested recovery. It is waiting in the admin panel.`,
    });
  }

  return publicView(row);
}

export async function completeRequest(userId: string): Promise<void> {
  const latest = await latestFor(userId);
  if (latest?.status !== 'ready') {
    throw new HttpError(403, 'This request is not ready yet.', { code: 'not_ready' });
  }
  must(
    await db
      .from('recovery_requests')
      .update({ status: 'completed', completed_at: new Date().toISOString() })
      .eq('id', latest.id),
  );
}

async function emailFor(userId: string): Promise<string | undefined> {
  const { data } = await db.auth.admin.getUserById(userId);
  return data.user?.email;
}

// Approval and the waiting time are both required; whichever comes last unlocks it.
export async function approve(requestId: string) {
  must(await db.rpc('recovery_tick'));
  const row = must(
    await db.from('recovery_requests').select('id, user_id, status, ready_at').eq('id', requestId).maybeSingle(),
  );
  if (!row) throw new HttpError(404, 'Request not found.');
  if (row.status !== 'pending') throw new HttpError(409, `This request is already ${row.status}.`);

  const waitOver = Date.parse(row.ready_at) <= Date.now();
  must(
    await db
      .from('recovery_requests')
      .update({ status: waitOver ? 'ready' : 'approved', approved_at: new Date().toISOString() })
      .eq('id', requestId),
  );

  const email = await emailFor(row.user_id);
  if (email) {
    await sendMail({
      to: email,
      subject: 'The system has approved your request',
      text: [
        'The system has approved your request to reset your Serein security questions.',
        waitOver
          ? 'You can set new questions now. Sign in and continue from the gate.'
          : `You can set new questions after ${new Date(row.ready_at).toUTCString()}. Sign in and continue from the gate.`,
        'If this was not you, change your password now.',
      ].join('\n\n'),
    });
  }
}

export async function deny(requestId: string) {
  must(await db.rpc('recovery_tick'));
  const row = must(
    await db.from('recovery_requests').select('id, status').eq('id', requestId).maybeSingle(),
  );
  if (!row) throw new HttpError(404, 'Request not found.');
  if (!['pending', 'approved', 'ready'].includes(row.status)) {
    throw new HttpError(409, `This request is already ${row.status}.`);
  }
  must(
    await db
      .from('recovery_requests')
      .update({ status: 'denied', denied_at: new Date().toISOString() })
      .eq('id', requestId),
  );
}
