import type { NextFunction, Request, Response } from 'express';
import { decodeJwt } from 'jose';
import { HttpError, must } from '../lib/errors.js';
import { GATE_COOKIE, readPass } from '../lib/gatePass.js';
import { db } from '../lib/supabase.js';

export interface AuthContext {
  userId: string;
  email: string;
  sessionId: string;
  // Sign-in methods on this session, newest proof of email ownership included.
  amr: { method: string; timestamp: number }[];
}

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
      passIssuedAt?: number;
    }
  }
}

export function authOf(req: Request): AuthContext {
  if (!req.auth) throw new HttpError(401, 'Please sign in again.');
  return req.auth;
}

// Confirms the Supabase access token with the auth server, then reads its claims.
export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
  if (!token) throw new HttpError(401, 'Please sign in again.');

  const { data, error } = await db.auth.getUser(token);
  if (error || !data.user?.email) throw new HttpError(401, 'Please sign in again.');

  const claims = decodeJwt(token);
  if (typeof claims.session_id !== 'string') throw new HttpError(401, 'Please sign in again.');

  req.auth = {
    userId: data.user.id,
    email: data.user.email,
    sessionId: claims.session_id,
    amr: Array.isArray(claims.amr) ? (claims.amr as AuthContext['amr']) : [],
  };
  next();
}

// Requires a valid gate pass bound to this exact Supabase session.
export async function requirePass(req: Request, _res: Response, next: NextFunction) {
  const auth = authOf(req);
  const pass = await readPass(req.cookies?.[GATE_COOKIE]);
  if (!pass || pass.userId !== auth.userId || pass.sessionId !== auth.sessionId) {
    throw new HttpError(403, 'Please pass the gate first.', { code: 'gate_required' });
  }
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

export async function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  const { userId } = authOf(req);
  const profile = must(await db.from('profiles').select('role').eq('id', userId).single());
  if (profile.role !== 'admin') throw new HttpError(404, 'Not found.');
  next();
}
