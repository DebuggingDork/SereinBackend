import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { reminderText, sendDailyReminders } from '../src/services/reminders.js';
import { db } from '../src/lib/supabase.js';
import { anonKey, app, bearer, createPerson, emailLinkToken, passGate, setUp, signIn } from './helpers.js';

// The local stack's mail catcher. Skipped when it is not there.
const MAILPIT = 'http://127.0.0.1:54324/api/v1';
const hasMailpit = await fetch(`${MAILPIT}/messages?limit=1`).then((res) => res.ok).catch(() => false);
const canSend = Boolean(anonKey && hasMailpit && process.env.SMTP_HOST);

async function subjectsFor(email: string, expected: number): Promise<string[]> {
  for (let i = 0; i < 40; i++) {
    const res = await fetch(`${MAILPIT}/search?query=${encodeURIComponent(`to:"${email}"`)}`);
    const { messages } = (await res.json()) as { messages: { Subject: string }[] };
    const subjects = messages.map((message) => message.Subject);
    if (subjects.length >= expected) return subjects;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return [];
}

describe('reminder text', () => {
  it('groups by kind and leaves out what is empty', () => {
    const text = reminderText([
      { kind: 'task', title: 'File taxes', due_on: '2026-10-27', amount: null },
      { kind: 'bill', title: 'Rent', due_on: '2026-10-28', amount: 15000 },
    ]);
    expect(text).toContain('Bills\nRent, due 2026-10-28 (15000)');
    expect(text).toContain('Tasks\nFile taxes, due 2026-10-27');
    expect(text).not.toContain('Loans');
  });
});

describe.skipIf(!canSend)('mail', () => {
  it('reaches the user on request and on approval, and never mentions an admin', async () => {
    const admin = await createPerson();
    await setUp(admin);
    await db.from('profiles').update({ role: 'admin' }).eq('id', admin.id);
    const adminToken = await signIn(admin.email);
    const adminCookie = await passGate(adminToken);

    const person = await createPerson();
    await setUp(person);
    const token = await emailLinkToken(person.email);
    const created = await request(app).post('/recovery/requests').set(bearer(token)).send({ kind: 'super' });
    expect(created.status).toBe(201);
    const row = (await db.from('recovery_requests').select('id').eq('user_id', person.id).single()).data!;

    const approved = await request(app)
      .post(`/admin/recovery/${row.id}/approve`)
      .set(bearer(adminToken))
      .set('Cookie', adminCookie);
    expect(approved.status).toBe(200);

    const subjects = await subjectsFor(person.email, 2);
    expect(subjects).toContain('A request to reset your Serein questions');
    expect(subjects).toContain('The system has approved your request');
    expect(subjects.join(' ')).not.toMatch(/admin/i);
  });

  it('sends one daily reminder, once, and respects the opt-out', async () => {
    const person = await createPerson();
    await setUp(person);
    await person.client.from('tasks').insert({ title: 'Due right now', due_on: '2026-01-01' });

    const quiet = await createPerson();
    await setUp(quiet);
    await quiet.client.from('profiles').update({ preferences: { emailReminders: false } }).eq('id', quiet.id);
    await quiet.client.from('tasks').insert({ title: 'Nobody tells me', due_on: '2026-01-01' });

    const secret = process.env.JOBS_SECRET!;
    const first = await request(app).post('/jobs/reminders').set('Authorization', `Bearer ${secret}`);
    expect(first.status).toBe(200);
    expect(first.body.sent).toBeGreaterThanOrEqual(1);

    expect(await subjectsFor(person.email, 1)).toEqual(['Due today on Serein']);
    const again = await sendDailyReminders();
    expect(again.sent).toBe(0);
    expect((await db.from('reminder_runs').select('sent_on').eq('user_id', person.id)).data!.length).toBe(1);
    expect((await db.from('reminder_runs').select('sent_on').eq('user_id', quiet.id)).data).toEqual([]);
  });
});
