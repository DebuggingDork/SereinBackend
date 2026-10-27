import { createRemoteJWKSet, decodeJwt, errors, jwtVerify, type JWTPayload } from 'jose';

export interface SessionClaims {
  userId: string;
  email: string;
  sessionId: string;
  amr: { method: string; timestamp: number }[];
}

// Only asymmetric algorithms: a symmetric key is never trusted from a key set, so a token
// signed with a public key as its secret cannot pass. Pinned to what Supabase can issue.
const ALGORITHMS = ['ES256', 'RS256', 'EdDSA'];
const AUDIENCE = 'authenticated';

// Verdicts that need no second opinion. Anything else, such as an older project signing
// with a shared secret, a rotated key or an unreachable key set, is left to the auth server.
const CONCLUSIVE = [
  errors.JWTExpired,
  errors.JWSSignatureVerificationFailed,
  errors.JWTClaimValidationFailed,
  errors.JWTInvalid,
  errors.JWSInvalid,
];

export type LocalVerdict =
  | { outcome: 'valid'; claims: SessionClaims }
  | { outcome: 'invalid' }
  | { outcome: 'unknown' };

// The claims this API requires, however the signature was confirmed. Returns null for
// tokens that are genuine but not for this project or not a signed-in person.
export function readClaims(payload: JWTPayload, issuer: string): SessionClaims | null {
  const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (
    payload.iss !== issuer ||
    !audience.includes(AUDIENCE) ||
    payload.role !== AUDIENCE ||
    payload.is_anonymous === true ||
    !payload.sub ||
    typeof payload.session_id !== 'string' ||
    typeof payload.email !== 'string' ||
    payload.email === ''
  ) {
    return null;
  }
  return {
    userId: payload.sub,
    email: payload.email,
    sessionId: payload.session_id,
    amr: Array.isArray(payload.amr) ? (payload.amr as SessionClaims['amr']) : [],
  };
}

// Same checks for a token the auth server has already confirmed.
export function readUnverifiedClaims(token: string, issuer: string): SessionClaims | null {
  try {
    return readClaims(decodeJwt(token), issuer);
  } catch {
    return null;
  }
}

export function createTokenVerifier(jwksUrl: string, issuer: string) {
  const keys = createRemoteJWKSet(new URL(jwksUrl), { timeoutDuration: 2000, cooldownDuration: 30_000 });

  return async function verifyLocally(token: string): Promise<LocalVerdict> {
    try {
      const { payload } = await jwtVerify(token, keys, { algorithms: ALGORITHMS, issuer, audience: AUDIENCE });
      const claims = readClaims(payload, issuer);
      return claims ? { outcome: 'valid', claims } : { outcome: 'invalid' };
    } catch (error) {
      return CONCLUSIVE.some((kind) => error instanceof kind) ? { outcome: 'invalid' } : { outcome: 'unknown' };
    }
  };
}
