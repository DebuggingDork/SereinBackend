import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { db } from '../src/lib/supabase.js';
import { anonKey, app, bearer, createPerson, passGate, setUp, signIn } from './helpers.js';

describe.skipIf(!anonKey)('gate hardening', () => {
  it('evaluates parallel guesses one at a time', async () => {
    const person = await createPerson();
    await setUp(person);
    const token = await signIn(person.email);
    await request(app).get('/gate/challenge').set(bearer(token));

    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        request(app).post('/gate/verify').set(bearer(token)).send({ answer: 'wrong' }),
      ),
    );
    const evaluated = results.filter((res) => res.status === 200);
    const refused = results.filter((res) => res.status === 429);
    expect(evaluated.length + refused.length).toBe(12);
    expect(evaluated.length).toBeLessThanOrEqual(4);

    const log = await db.from('gate_attempts').select('question_id').eq('user_id', person.id).eq('success', false);
    expect(log.data!.length).toBe(evaluated.length);
    const state = await db.from('gate_state').select('failed_count, verifying_until').eq('user_id', person.id).single();
    expect(state.data!.failed_count).toBe(evaluated.length);
  });

  it('recovers by itself if a check dies halfway', async () => {
    const person = await createPerson();
    await setUp(person);
    const token = await signIn(person.email);
    await request(app).get('/gate/challenge').set(bearer(token));

    await db.from('gate_state').update({ verifying_until: new Date(Date.now() + 60_000).toISOString() }).eq('user_id', person.id);
    const busy = await request(app).post('/gate/verify').set(bearer(token)).send({ answer: 'wrong' });
    expect(busy.status).toBe(429);
    expect(busy.body.code).toBe('busy');

    await db.from('gate_state').update({ verifying_until: new Date(Date.now() - 1000).toISOString() }).eq('user_id', person.id);
    expect((await request(app).post('/gate/verify').set(bearer(token)).send({ answer: 'wrong' })).body.ok).toBe(false);
  });

  it('ends a pass when the session is locked, even if the cookie is replayed', async () => {
    const person = await createPerson();
    await setUp(person);
    const token = await signIn(person.email);
    const cookie = await passGate(token);
    expect((await request(app).get('/gate/questions').set(bearer(token)).set('Cookie', cookie)).status).toBe(200);

    await request(app).post('/gate/lock').set(bearer(token)).set('Cookie', cookie);
    const replay = await request(app).get('/gate/questions').set(bearer(token)).set('Cookie', cookie);
    expect(replay.status).toBe(403);
    expect(replay.body.code).toBe('gate_required');
  });

  it('cannot be switched off from the browser', async () => {
    const person = await createPerson();
    await setUp(person);
    const res = await person.client.from('profiles').update({ gate_required: false }).eq('id', person.id);
    expect(res.error).not.toBeNull();
  });

  it('logs the real address behind a proxy, not one the caller made up', async () => {
    const person = await createPerson();
    await setUp(person);
    const token = await signIn(person.email);
    await request(app).get('/gate/challenge').set(bearer(token));
    await request(app)
      .post('/gate/verify')
      .set(bearer(token))
      .set('X-Forwarded-For', '6.6.6.6, 203.0.113.9')
      .send({ answer: 'wrong' });
    const log = await db.from('gate_attempts').select('ip').eq('user_id', person.id).eq('success', false).single();
    expect(log.data!.ip).toBe('203.0.113.9');
  });

  it('keeps the same data when the email changes', async () => {
    const person = await createPerson();
    await setUp(person);
    await person.client.from('tasks').insert({ title: 'still mine' });
    const updated = await db.auth.admin.updateUserById(person.id, { email: `new-${person.email}` });
    expect(updated.error).toBeNull();
    expect(updated.data.user!.id).toBe(person.id);
    const tasks = await db.from('tasks').select('title').eq('user_id', person.id);
    expect(tasks.data).toEqual([{ title: 'still mine' }]);
  });

  it('will not sign in an unconfirmed account', async () => {
    const email = `unconfirmed-${Date.now()}@serein.test`;
    await db.auth.admin.createUser({ email, password: 'correct-horse-battery', email_confirm: false });
    await expect(signIn(email)).rejects.toThrow();
  });
});

describe.skipIf(!anonKey)('admin panel visibility', () => {
  it('looks like nothing is there to anyone but an admin', async () => {
    const person = await createPerson();
    const cookie = await setUp(person);
    const unknownPath = await request(app).get('/admin/nothing-here');

    for (const path of ['/admin/users', '/admin/recovery', '/admin/security-log']) {
      const noToken = await request(app).get(path);
      const badToken = await request(app).get(path).set(bearer('nonsense'));
      const noPass = await request(app).get(path).set(bearer(person.token));
      const withPass = await request(app).get(path).set(bearer(person.token)).set('Cookie', cookie);
      for (const res of [noToken, badToken, noPass, withPass]) {
        expect(res.status).toBe(404);
        expect(res.body).toEqual(unknownPath.body);
      }
    }
  });

  it('asks a real admin for the gate, then serves the directory', async () => {
    const admin = await createPerson();
    await setUp(admin);
    await db.from('profiles').update({ role: 'admin' }).eq('id', admin.id);
    const token = await signIn(admin.email);

    const blocked = await request(app).get('/admin/users').set(bearer(token));
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('gate_required');

    const cookie = await passGate(token);
    const users = await request(app).get('/admin/users').set(bearer(token)).set('Cookie', cookie);
    expect(users.status).toBe(200);
    const me = users.body.users.find((user: { id: string }) => user.id === admin.id);
    expect(me).toMatchObject({ email: admin.email, confirmed: true, role: 'admin' });
    expect(me.lastSignIn).toBeTruthy();
    expect(JSON.stringify(users.body)).not.toMatch(/password|hash/i);

    const log = await request(app).get('/admin/security-log?outcome=passed').set(bearer(token)).set('Cookie', cookie);
    expect(log.body.attempts.some((row: { email: string }) => row.email === admin.email)).toBe(true);

    const notAnId = await request(app).post('/admin/recovery/not-a-uuid/approve').set(bearer(token)).set('Cookie', cookie);
    expect(notAnId.status).toBe(404);
  });

  it('does not let the browser call the directory', async () => {
    const person = await createPerson();
    await setUp(person);
    expect((await person.client.rpc('admin_user_directory')).error).not.toBeNull();
    expect((await person.client.rpc('due_reminders')).error).not.toBeNull();
    expect((await person.client.rpc('gate_claim_attempt', { p_user_id: person.id })).error).not.toBeNull();
    expect((await person.client.rpc('complete_recovery', { p_user_id: person.id, p_questions: [] })).error).not.toBeNull();
  });
});
