import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { app } from './helpers.js';
import { parseOrigins } from '../src/config/env.js';
import { errorHandler, limiter } from '../src/middleware/common.js';

describe('error responses', () => {
  it('answers malformed and oversized bodies as client errors, without quoting them', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const malformed = await request(app)
      .post('/gate/verify')
      .set('Content-Type', 'application/json')
      .send('{"answer": secret-looking-input');
    expect(malformed.status).toBe(400);
    expect(JSON.stringify(malformed.body)).not.toContain('secret-looking-input');

    const oversized = await request(app)
      .post('/gate/verify')
      .send({ answer: 'x'.repeat(64 * 1024) });
    expect(oversized.status).toBe(413);
    expect(logged).not.toHaveBeenCalled();
    logged.mockRestore();
  });

  it('hides everything about an unexpected failure', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = express();
    broken.get('/', () => {
      throw new Error('password authentication failed for user "postgres" at db.internal:5432');
    });
    broken.use(errorHandler);
    const res = await request(broken).get('/');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Something went wrong on our side.' });
    logged.mockRestore();
  });

  it('never lets responses be cached along the way', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers.etag).toBeUndefined();
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('the jobs route', () => {
  it('does not exist without the right secret', async () => {
    expect((await request(app).post('/jobs/reminders')).status).toBe(404);
    expect((await request(app).post('/jobs/reminders').set('Authorization', 'Bearer wrong')).status).toBe(404);
  });
});

describe('cross-origin settings', () => {
  it('only allows the configured frontend', async () => {
    const allowed = process.env.FRONTEND_ORIGIN?.split(',')[0] ?? 'http://localhost:3000';
    const good = await request(app).options('/gate/verify').set('Origin', allowed).set('Access-Control-Request-Method', 'POST');
    expect(good.headers['access-control-allow-origin']).toBe(allowed);
    expect(good.headers['access-control-allow-credentials']).toBe('true');

    const evil = await request(app).options('/gate/verify').set('Origin', 'https://evil.example').set('Access-Control-Request-Method', 'POST');
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('reads a list, tolerates tidy-up differences and refuses what could never match', () => {
    expect(parseOrigins('https://a.example, https://b.example/')).toEqual(['https://a.example', 'https://b.example']);
    expect(parseOrigins('https://a.example,')).toEqual(['https://a.example']);
    expect(() => parseOrigins('*')).toThrow(/FRONTEND_ORIGIN/);
    expect(() => parseOrigins('a.example')).toThrow(/FRONTEND_ORIGIN/);
  });
});

describe('rate limits behind a proxy', () => {
  function limited(hops: number) {
    const instance = express();
    instance.set('trust proxy', hops);
    instance.get('/', limiter(1, 2), (req, res) => {
      res.json({ ip: req.ip });
    });
    return instance;
  }
  const hit = (instance: express.Express, forwardedFor: string) =>
    request(instance).get('/').set('X-Forwarded-For', forwardedFor);

  it('cannot be dodged by making up addresses', async () => {
    const instance = limited(1);
    expect((await hit(instance, '1.1.1.1, 203.0.113.9')).status).toBe(200);
    expect((await hit(instance, '2.2.2.2, 203.0.113.9')).status).toBe(200);
    const third = await hit(instance, '3.3.3.3, 203.0.113.9');
    expect(third.status).toBe(429);
    expect(third.body.error).toBeTruthy();
  });

  it('keeps real people apart, and counts the right hop on Render behind Vercel', async () => {
    const instance = limited(2);
    const res = await hit(instance, '6.6.6.6, 198.51.100.7, 203.0.113.1');
    expect(res.body.ip).toBe('198.51.100.7');
    for (let i = 0; i < 3; i++) await hit(instance, '6.6.6.6, 198.51.100.7, 203.0.113.1');
    expect((await hit(instance, '198.51.100.8, 203.0.113.1')).status).toBe(200);
  });
});

describe('the gate pass cookie', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('is locked down in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.resetModules();
    const { passCookieOptions, passLifetimeMs } = await import('../src/lib/gatePass.js');
    expect(passCookieOptions()).toMatchObject({ httpOnly: true, secure: true, sameSite: 'lax', path: '/' });
    expect(passCookieOptions().maxAge).toBe(passLifetimeMs());
    expect(passLifetimeMs()).toBeLessThanOrEqual(72 * 3_600_000);
  });
});
