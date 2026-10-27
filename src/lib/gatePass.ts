import type { CookieOptions } from 'express';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { env, isProduction } from '../config/env.js';

export const GATE_COOKIE = 'serein_gate';
const ISSUER = 'serein-backend';
const ALGORITHM = 'EdDSA';

const privateKey = createPrivateKey(Buffer.from(env.GATE_PASS_PRIVATE_KEY, 'base64').toString('utf8'));
const publicKey = createPublicKey(privateKey);

export const passLifetimeMs = () => env.GATE_PASS_TTL_HOURS * 60 * 60 * 1000;

export interface GatePass {
  userId: string;
  sessionId: string;
  issuedAt: number;
}

export async function issuePass(userId: string, sessionId: string): Promise<string> {
  return new SignJWT({ sid: sessionId })
    .setProtectedHeader({ alg: ALGORITHM })
    .setSubject(userId)
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(`${env.GATE_PASS_TTL_HOURS}h`)
    .sign(privateKey);
}

export async function readPass(token: string | undefined): Promise<GatePass | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, publicKey, { issuer: ISSUER, algorithms: [ALGORITHM] });
    if (!payload.sub || typeof payload.sid !== 'string' || !payload.iat) return null;
    return { userId: payload.sub, sessionId: payload.sid, issuedAt: payload.iat };
  } catch {
    return null;
  }
}

export function passCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: '/',
    maxAge: passLifetimeMs(),
  };
}
