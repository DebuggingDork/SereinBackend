import type { NextFunction, Request, Response } from 'express';
import { env, supabaseIssuer } from '../config/env.js';
import { HttpError, maybe, must } from '../lib/errors.js';
import { GATE_COOKIE, readPass } from '../lib/gatePass.js';
import { createTokenVerifier, readUnverifiedClaims, type SessionClaims } from '../lib/sessionToken.js';
import { db } from '../lib/supabase.js';

export type AuthContext = SessionClaims;

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
      passIssuedAt?: number;
    }
  }
}

const SIGN_IN_AGAIN = 'Please sign in again.';

const verifyLocally = createTokenVerifier(`${env.SUPABASE_URL.replace(/\/$/, '')}/auth/v1/.well-known/jwks.json`, supabaseIssuer);

export function authOf(req: Request): AuthContext {
  if (!req.auth) throw new HttpError(401, SIGN_IN_AGAIN);
  return req.auth;
}

function bearerToken(req: Request): string {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
  if (!token) throw new HttpError(401, SIGN_IN_AGAIN);
  return token;
}

// Asks the auth server, which also knows whether the session has since been signed out.
// An outage must not read as "signed out": the app would throw the user back to login.
async function confirmWithAuthServer(token: string): Promise<SessionClaims> {
  const { data, error } = await db.auth.getUser(token);
  if (error && (error.name === 'AuthRetryableFetchError' || (error.status ?? 0) >= 500)) {
    throw new HttpError(503, 'We could not check your session. Try again in a moment.', { code: 'auth_unavailable' });
  }
  if (error || !data.user?.email) throw new HttpError(401, SIGN_IN_AGAIN);

  const claims = readUnverifiedClaims(token, supabaseIssuer);
  if (!claims || claims.userId !== data.user.id) throw new HttpError(401, SIGN_IN_AGAIN);
  return { ...claims, email: data.user.email };
}

// For reads that only show a user their own gate state. The signature is checked here,
// with no network call, so a token signed out elsewhere keeps working until it expires
// (an hour at most). That is the same trust row-level security gives it on data reads.
export async function requireSession(req: Request, _res: Response, next: NextFunction) {
  const token = bearerToken(req);
  const verdict = await verifyLocally(token);
  if (verdict.outcome === 'invalid') throw new HttpError(401, SIGN_IN_AGAIN);
  req.auth = verdict.outcome === 'valid' ? verdict.claims : await confirmWithAuthServer(token);
  next();
}

// For anything that changes state or opens a gate. Forged and expired tokens are still
// turned away locally, so only plausible tokens reach the auth server.
export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const token = bearerToken(req);
  const verdict = await verifyLocally(token);
  if (verdict.outcome === 'invalid') throw new HttpError(401, SIGN_IN_AGAIN);
  req.auth = await confirmWithAuthServer(token);
  next();
}

// Requires a valid gate pass bound to this exact Supabase session, and that the session
// is still open: locking must end a pass even if a copy of the cookie survives.
export async function requirePass(req: Request, _res: Response, next: NextFunction) {
  const auth = authOf(req);
  const pass = await readPass(req.cookies?.[GATE_COOKIE]);
  if (!pass || pass.userId !== auth.userId || pass.sessionId !== auth.sessionId) {
    throw new HttpError(403, 'Please pass the gate first.', { code: 'gate_required' });
  }
  const open = maybe(
    await db
      .from('gate_sessions')
      .select('session_id')
      .eq('session_id', auth.sessionId)
      .eq('user_id', auth.userId)
      .gt('expires_at', new Date().toISOString())
      .maybeSingle(),
  );
  if (!open) throw new HttpError(403, 'Please pass the gate first.', { code: 'gate_required' });
  req.passIssuedAt = pass.issuedAt;
  next();
}

// Sensitive changes ask for a recent answer, not just a live pass.
export function requireFreshPass(maxAgeSeconds: number) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const age = Date.now() / 1000 - (req.passIssuedAt ?? 0);
    if (age > maxAgeSeconds) {
      throw new HttpError(403, 'Answer one question to confirm it is you.', { code: 'gate_stale' });
    }
    next();
  };
}

// To anyone but an admin the panel does not exist, whether signed in or not. Only a real
// admin is told about the gate. An auth outage still reports as an outage.
export async function requireAdmin(req: Request, res: Response, next: NextFunction) {
  try {
    await requireAuth(req, res, () => {});
  } catch (error) {
    if (error instanceof HttpError && error.status === 401) throw new HttpError(404, 'Not found.');
    throw error;
  }
  const profile = must(await db.from('profiles').select('role').eq('id', authOf(req).userId).single());
  if (profile.role !== 'admin') throw new HttpError(404, 'Not found.');
  next();
}
