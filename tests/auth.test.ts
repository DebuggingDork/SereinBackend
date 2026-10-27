import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTokenVerifier, readClaims } from '../src/lib/sessionToken.js';
import { db } from '../src/lib/supabase.js';
import { anonKey, app, bearer, createPerson, setUp, signIn } from './helpers.js';

const ISSUER = 'https://project.example/auth/v1';
const GOOD_CLAIMS = {
  role: 'authenticated',
  email: 'someone@serein.test',
  session_id: '00000000-0000-4000-8000-000000000001',
};

describe('local token verification', () => {
  let server: Server;
  let verify: ReturnType<typeof createTokenVerifier>;
  let goodKey: CryptoKey;
  let otherKey: CryptoKey;

  const sign = (key: CryptoKey, overrides: { iss?: string; aud?: string; exp?: string; claims?: object } = {}) =>
    new SignJWT({ ...GOOD_CLAIMS, ...overrides.claims })
      .setProtectedHeader({ alg: 'ES256', kid: 'good' })
      .setSubject('00000000-0000-4000-8000-000000000002')
      .setIssuer(overrides.iss ?? ISSUER)
      .setAudience(overrides.aud ?? 'authenticated')
      .setIssuedAt()
      .setExpirationTime(overrides.exp ?? '1h')
      .sign(key);

  beforeAll(async () => {
    const good = await generateKeyPair('ES256');
    goodKey = good.privateKey;
    otherKey = (await generateKeyPair('ES256')).privateKey;
    const jwk = { ...(await exportJWK(good.publicKey)), kid: 'good', alg: 'ES256', use: 'sig' };
    server = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ keys: [jwk] }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    verify = createTokenVerifier(`http://127.0.0.1:${(server.address() as AddressInfo).port}/jwks.json`, ISSUER);
  });
  afterAll(() => server.close());

  it('accepts a token signed by the project key, and reads its claims', async () => {
    const verdict = await verify(await sign(goodKey));
    expect(verdict.outcome).toBe('valid');
    if (verdict.outcome === 'valid') expect(verdict.claims.sessionId).toBe(GOOD_CLAIMS.session_id);
  });

  it('rejects a forged signature, garbage and an expired token without asking anyone', async () => {
    expect((await verify(await sign(otherKey))).outcome).toBe('invalid');
    expect((await verify('nonsense')).outcome).toBe('invalid');
    expect((await verify(await sign(goodKey, { exp: '-1m' }))).outcome).toBe('invalid');
  });

  it('rejects a wrong audience, issuer or role even when correctly signed', async () => {
    expect((await verify(await sign(goodKey, { aud: 'someone-else' }))).outcome).toBe('invalid');
    expect((await verify(await sign(goodKey, { iss: 'https://evil.example' }))).outcome).toBe('invalid');
    expect((await verify(await sign(goodKey, { claims: { role: 'anon' } }))).outcome).toBe('invalid');
    expect((await verify(await sign(goodKey, { claims: { is_anonymous: true } }))).outcome).toBe('invalid');
  });

  it('never trusts a shared-secret token locally, leaving it to the auth server', async () => {
    const token = await new SignJWT(GOOD_CLAIMS)
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('x')
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode('a-secret-anyone-could-have-picked'));
    expect((await verify(token)).outcome).toBe('unknown');
  });

  it('asks the auth server when the key set cannot be reached', async () => {
    const unreachable = createTokenVerifier('http://127.0.0.1:9/jwks.json', ISSUER);
    expect((await unreachable(await sign(goodKey))).outcome).toBe('unknown');
  });

  it('applies the same claim rules to tokens the auth server confirmed', () => {
    const base = { ...GOOD_CLAIMS, sub: 'x', iss: ISSUER, aud: 'authenticated' };
    expect(readClaims(base, ISSUER)).not.toBeNull();
    expect(readClaims({ ...base, aud: 'other' }, ISSUER)).toBeNull();
    expect(readClaims({ ...base, iss: 'https://evil.example' }, ISSUER)).toBeNull();
    expect(readClaims({ ...base, role: 'service_role' }, ISSUER)).toBeNull();
  });
});

describe.skipIf(!anonKey)('sessions end to end', () => {
  it('turns away a signed-out session on every route that changes something', async () => {
    const person = await createPerson();
    await setUp(person);
    const token = await signIn(person.email);
    expect((await request(app).post('/gate/verify').set(bearer(token)).send({ answer: 'x' })).status).not.toBe(401);

    const { error } = await db.auth.admin.signOut(token);
    expect(error).toBeNull();

    const verify = await request(app).post('/gate/verify').set(bearer(token)).send({ answer: 'x' });
    expect(verify.status).toBe(401);
    const lock = await request(app).post('/gate/lock').set(bearer(token));
    expect(lock.status).toBe(401);
    const recover = await request(app).post('/recovery/requests').set(bearer(token)).send({ kind: 'normal' });
    expect(recover.status).toBe(401);
  });

  it('answers gate reads for a live session and rejects a tampered one', async () => {
    const person = await createPerson();
    expect((await request(app).get('/gate/challenge').set(bearer(person.token))).status).toBe(200);
    const [header, payload] = person.token.split('.');
    const tampered = `${header}.${payload}.AAAA`;
    expect((await request(app).get('/gate/challenge').set(bearer(tampered))).status).toBe(401);
  });
});
