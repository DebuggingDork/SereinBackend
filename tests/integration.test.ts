import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { db } from '../src/lib/supabase.js';

// Runs against a local Supabase stack. `supabase start`, then set SUPABASE_ANON_KEY
// and SUPABASE_SERVICE_ROLE_KEY. Skipped otherwise.
const anonKey = process.env.SUPABASE_ANON_KEY;
const url = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321';
const app = createApp();
const PASSWORD = 'correct-horse-battery';

interface Person {
  id: string;
  email: string;
  client: SupabaseClient;
  token: string;
}

function browserClient(token?: string) {
  return createClient(url, anonKey!, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
  });
}

async function createPerson(): Promise<Person> {
  const email = `${randomUUID()}@serein.test`;
  const { data, error } = await db.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error) throw error;
  const session = await signIn(email);
  return { id: data.user.id, email, client: browserClient(session), token: session };
}

async function signIn(email: string): Promise<string> {
  const { data, error } = await browserClient().auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw error;
  return data.session.access_token;
}

async function emailLinkToken(email: string): Promise<string> {
  const { data, error } = await db.auth.admin.generateLink({ type: 'magiclink', email });
  if (error) throw error;
  const { data: verified, error: verifyError } = await browserClient().auth.verifyOtp({
    token_hash: data.properties.hashed_token,
    type: 'magiclink',
  });
  if (verifyError) throw verifyError;
  return verified.session!.access_token;
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const passCookie = (res: request.Response) => (res.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;

const QUESTIONS = [
  { question: 'First street you lived on?', answer: 'Serein Street' },
  { question: 'Name of your first pet?', answer: 'Biscuit' },
  { question: 'Favourite teacher?', answer: 'Mrs Rao' },
];
const answerTo = (question: string) => QUESTIONS.find((q) => q.question === question)!.answer;

async function setUp(person: Person) {
  const res = await request(app).post('/gate/setup').set(bearer(person.token)).send({ questions: QUESTIONS });
  expect(res.status).toBe(201);
  return passCookie(res);
}

async function passGate(token: string) {
  const challenge = await request(app).get('/gate/challenge').set(bearer(token));
  const res = await request(app)
    .post('/gate/verify')
    .set(bearer(token))
    .send({ answer: answerTo(challenge.body.question) });
  expect(res.body.ok).toBe(true);
  return passCookie(res);
}

describe.skipIf(!anonKey)('security gate', () => {
  let person: Person;
  beforeAll(async () => {
    person = await createPerson();
  });

  it('rejects requests without a session', async () => {
    expect((await request(app).get('/gate/challenge')).status).toBe(401);
    expect((await request(app).get('/gate/challenge').set(bearer('nonsense'))).status).toBe(401);
  });

  it('forces question setup on first login', async () => {
    const res = await request(app).get('/gate/challenge').set(bearer(person.token));
    expect(res.body).toEqual({ state: 'setup' });
  });

  it('locks the data away until the gate is passed, even through the API', async () => {
    const { data } = await person.client.from('categories').select('id');
    expect(data).toEqual([]);
    const insert = await person.client.from('tasks').insert({ title: 'sneaky' });
    expect(insert.error).not.toBeNull();
    const promote = await person.client.from('profiles').update({ display_name: 'x' }).eq('id', person.id).select();
    expect(promote.data).toEqual([]);
  });

  it('opens the data once questions are saved', async () => {
    await setUp(person);
    const { data } = await person.client.from('categories').select('id');
    expect(data!.length).toBeGreaterThan(5);
  });

  it('refuses a second first-time setup', async () => {
    const res = await request(app).post('/gate/setup').set(bearer(person.token)).send({ questions: QUESTIONS });
    expect(res.status).toBe(409);
  });

  it('never exposes hashes to the browser or any endpoint', async () => {
    const direct = await person.client.from('security_questions').select('*');
    expect(direct.error).not.toBeNull();
    const cookie = await passGate(person.token);
    const res = await request(app).get('/gate/questions').set(bearer(person.token)).set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain('argon2');
  });

  it('does not let the role be promoted from the browser', async () => {
    const res = await person.client.from('profiles').update({ role: 'admin' }).eq('id', person.id);
    expect(res.error).not.toBeNull();
  });

  it('asks a new session again and shuts that session out of the data', async () => {
    const fresh = await signIn(person.email);
    const client = browserClient(fresh);
    expect((await client.from('categories').select('id')).data).toEqual([]);

    const challenge = await request(app).get('/gate/challenge').set(bearer(fresh));
    expect(challenge.body.state).toBe('challenge');

    // Reloading cannot be used to shop for an easier question.
    const again = await request(app).get('/gate/challenge').set(bearer(fresh));
    expect(again.body.question).toBe(challenge.body.question);
  });

  it('accepts answers regardless of capitals and spaces', async () => {
    const token = await signIn(person.email);
    const challenge = await request(app).get('/gate/challenge').set(bearer(token));
    const messy = `  ${answerTo(challenge.body.question).toUpperCase().replace(' ', '    ')} `;
    const res = await request(app).post('/gate/verify').set(bearer(token)).send({ answer: messy });
    expect(res.body.ok).toBe(true);
    expect(res.headers['set-cookie']![0]).toMatch(/HttpOnly/i);
  });

  it('roasts wrong answers, rotates the question and cools down', async () => {
    const token = await signIn(person.email);
    let current = (await request(app).get('/gate/challenge').set(bearer(token))).body.question;

    const roasts: string[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await request(app).post('/gate/verify').set(bearer(token)).send({ answer: 'wrong' });
      expect(res.body.ok).toBe(false);
      expect(res.body.question).not.toBe(current);
      current = res.body.question;
      roasts.push(res.body.roast);
    }
    expect(roasts[0]).toBe('Nope. Nice try, detective.');
    expect(roasts[2]).toContain('Use your brain');

    const fourth = await request(app).post('/gate/verify').set(bearer(token)).send({ answer: 'wrong' });
    expect(fourth.body.lockedUntil).toBeTruthy();
    const seconds = (Date.parse(fourth.body.lockedUntil) - Date.now()) / 1000;
    expect(seconds).toBeGreaterThan(20);
    expect(seconds).toBeLessThanOrEqual(30);

    // Even the right answer is refused during a cooldown.
    const locked = await request(app).post('/gate/verify').set(bearer(token)).send({ answer: 'Biscuit' });
    expect(locked.status).toBe(429);

    const log = await db.from('gate_attempts').select('success, ip').eq('user_id', person.id).eq('success', false);
    expect(log.data!.length).toBeGreaterThanOrEqual(4);

    await db.from('gate_state').update({ locked_until: null, failed_count: 0 }).eq('user_id', person.id);
  });

  it('works with a single question and with ten', async () => {
    for (const count of [1, 10]) {
      const someone = await createPerson();
      const questions = Array.from({ length: count }, (_, i) => ({ question: `Question ${i}?`, answer: 'yes' }));
      const res = await request(app).post('/gate/setup').set(bearer(someone.token)).send({ questions });
      expect(res.status).toBe(201);

      const token = await signIn(someone.email);
      const challenge = await request(app).get('/gate/challenge').set(bearer(token));
      expect(challenge.body.state).toBe('challenge');
      const ok = await request(app).post('/gate/verify').set(bearer(token)).send({ answer: 'YES' });
      expect(ok.body.ok).toBe(true);
    }
  });

  it('rejects an eleventh question', async () => {
    const someone = await createPerson();
    const questions = Array.from({ length: 11 }, (_, i) => ({ question: `Question ${i}?`, answer: 'yes' }));
    const res = await request(app).post('/gate/setup').set(bearer(someone.token)).send({ questions });
    expect(res.status).toBe(400);
  });

  it('locking closes the data again straight away', async () => {
    const token = await signIn(person.email);
    const cookie = await passGate(token);
    const client = browserClient(token);
    expect((await client.from('categories').select('id')).data!.length).toBeGreaterThan(0);
    await request(app).post('/gate/lock').set(bearer(token)).set('Cookie', cookie);
    expect((await client.from('categories').select('id')).data).toEqual([]);
  });

  it('rejects a pass from another session', async () => {
    const tokenA = await signIn(person.email);
    const cookie = await passGate(tokenA);
    const tokenB = await signIn(person.email);
    const res = await request(app).get('/gate/questions').set(bearer(tokenB)).set('Cookie', cookie);
    expect(res.status).toBe(403);
  });
});

describe.skipIf(!anonKey)('data isolation', () => {
  it('keeps two people completely apart, including through direct API calls', async () => {
    const [a, b] = [await createPerson(), await createPerson()];
    await setUp(a);
    await setUp(b);

    const account = await a.client.from('accounts').insert({ name: 'Salary', kind: 'bank', balance: 1000 }).select().single();
    expect(account.error).toBeNull();

    expect((await b.client.from('accounts').select()).data).toEqual([]);
    expect((await b.client.from('accounts').select().eq('id', account.data.id)).data).toEqual([]);

    const update = await b.client.from('accounts').update({ balance: 0 }).eq('id', account.data.id).select();
    expect(update.data).toEqual([]);
    const remove = await b.client.from('accounts').delete().eq('id', account.data.id).select();
    expect(remove.data).toEqual([]);

    const forged = await b.client.from('tasks').insert({ title: 'planted', user_id: a.id });
    expect(forged.error).not.toBeNull();

    // A transaction aimed at someone else's account cannot move their balance.
    await b.client.from('transactions').insert({ kind: 'expense', amount: 999, account_id: account.data.id });
    const after = await a.client.from('accounts').select('balance').eq('id', account.data.id).single();
    expect(Number(after.data!.balance)).toBe(1000);

    const anon = browserClient();
    expect((await anon.from('accounts').select()).error).not.toBeNull();
  });
});

describe.skipIf(!anonKey)('finance rules', () => {
  it('moves balances with transactions, and refuses card numbers', async () => {
    const person = await createPerson();
    await setUp(person);
    const { client } = person;

    const bank = (await client.from('accounts').insert({ name: 'HDFC', kind: 'bank', balance: 5000 }).select().single()).data;
    const card = (await client.from('accounts').insert({ name: 'Axis', kind: 'card', balance: 0, credit_limit: 10000 }).select().single()).data;
    const balanceOf = async (id: string) => Number((await client.from('accounts').select('balance').eq('id', id).single()).data!.balance);

    const spend = (await client.from('transactions').insert({ kind: 'expense', amount: 200, account_id: bank.id }).select().single()).data;
    expect(await balanceOf(bank.id)).toBe(4800);

    await client.from('transactions').update({ amount: 300 }).eq('id', spend.id);
    expect(await balanceOf(bank.id)).toBe(4700);

    await client.from('transactions').delete().eq('id', spend.id);
    expect(await balanceOf(bank.id)).toBe(5000);

    await client.from('transactions').insert({ kind: 'expense', amount: 500, account_id: card.id });
    expect(await balanceOf(card.id)).toBe(500);

    await client.from('transactions').insert({ kind: 'transfer', amount: 500, account_id: bank.id, to_account_id: card.id });
    expect(await balanceOf(bank.id)).toBe(4500);
    expect(await balanceOf(card.id)).toBe(0);

    const carded = await client.from('transactions').insert({
      kind: 'expense', amount: 1, account_id: bank.id, notes: 'paid with 4111 1111 1111 4829',
    });
    expect(carded.error).not.toBeNull();
    const badFour = await client.from('accounts').insert({ name: 'x', kind: 'bank', last_four: '12345' });
    expect(badFour.error).not.toBeNull();
  });

  it('computes every chart helper for an empty account', async () => {
    const person = await createPerson();
    await setUp(person);
    const today = new Date().toISOString().slice(0, 10);
    const calls: [string, Record<string, unknown>?][] = [
      ['spending_by_category', { p_from: today, p_to: today }],
      ['income_vs_expense'], ['daily_spending'], ['balance_trend'],
      ['spending_by_source', { p_from: today, p_to: today }],
      ['subscription_cost_by_month'], ['debts_by_person'], ['net_worth_now'], ['safe_to_spend'],
      ['budget_progress'], ['completion_rate_daily'], ['tasks_created_vs_completed'],
      ['tasks_by_category'], ['on_time_vs_late'], ['task_streaks'], ['daily_calories'],
      ['macro_split'], ['weekly_macros'], ['daily_water'], ['meal_timing'], ['mood_series'],
      ['mood_counts'], ['entries_per_week'], ['writing_streak'], ['upcoming_alerts'], ['home_summary'],
      ['capture_net_worth'], ['search_diary', { p_query: 'rain' }],
    ];
    for (const [name, args] of calls) {
      const { error } = await person.client.rpc(name, args);
      expect(error, name).toBeNull();
    }
  });
});

describe.skipIf(!anonKey)('recovery', () => {
  async function makeAdmin() {
    const admin = await createPerson();
    await setUp(admin);
    await db.from('profiles').update({ role: 'admin' }).eq('id', admin.id);
    const token = await signIn(admin.email);
    return { token, cookie: await passGate(token) };
  }

  it('hides the admin panel from everyone else', async () => {
    const person = await createPerson();
    const cookie = await setUp(person);
    const res = await request(app).get('/admin/recovery').set(bearer(person.token)).set('Cookie', cookie);
    expect(res.status).toBe(404);
  });

  it('requires a confirmed email, approval and the wait, then keeps the same user id', async () => {
    const admin = await makeAdmin();
    const person = await createPerson();
    await setUp(person);
    await person.client.from('tasks').insert({ title: 'keep me' });

    const passwordOnly = await signIn(person.email);
    const refused = await request(app).post('/recovery/requests').set(bearer(passwordOnly)).send({ kind: 'normal' });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('email_unconfirmed');

    const token = await emailLinkToken(person.email);
    const created = await request(app).post('/recovery/requests').set(bearer(token)).send({ kind: 'normal' });
    expect(created.status).toBe(201);
    expect(created.body.state).toBe('waiting');
    const minutes = (Date.parse(created.body.readyAt) - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(89);
    expect(JSON.stringify(created.body)).not.toMatch(/admin/i);

    const newQuestions = { questions: [{ question: 'New question here?', answer: 'new answer' }] };
    expect((await request(app).post('/recovery/complete').set(bearer(token)).send(newQuestions)).status).toBe(403);

    // The wait passing without approval is not enough.
    const row = (await db.from('recovery_requests').select('id').eq('user_id', person.id).single()).data!;
    await db.from('recovery_requests').update({ ready_at: new Date(Date.now() - 1000).toISOString() }).eq('id', row.id);
    expect((await request(app).get('/recovery/current').set(bearer(token))).body.state).toBe('waiting');
    expect((await request(app).post('/recovery/complete').set(bearer(token)).send(newQuestions)).status).toBe(403);

    // Approval without the wait is not enough either.
    await db.from('recovery_requests').update({ ready_at: new Date(Date.now() + 3_600_000).toISOString() }).eq('id', row.id);
    const approve = await request(app)
      .post(`/admin/recovery/${row.id}/approve`)
      .set(bearer(admin.token))
      .set('Cookie', admin.cookie);
    expect(approve.status).toBe(200);
    expect((await request(app).get('/recovery/current').set(bearer(token))).body.state).toBe('waiting');
    expect((await request(app).post('/recovery/complete').set(bearer(token)).send(newQuestions)).status).toBe(403);

    // Both together unlock it.
    await db.from('recovery_requests').update({ ready_at: new Date(Date.now() - 1000).toISOString() }).eq('id', row.id);
    expect((await request(app).get('/recovery/current').set(bearer(token))).body.state).toBe('ready');
    const done = await request(app).post('/recovery/complete').set(bearer(token)).send(newQuestions);
    expect(done.status).toBe(200);

    const client = browserClient(token);
    const { data: tasks } = await client.from('tasks').select('title');
    expect(tasks).toEqual([{ title: 'keep me' }]);

    const relogin = await signIn(person.email);
    const challenge = await request(app).get('/gate/challenge').set(bearer(relogin));
    expect(challenge.body.question).toBe('New question here?');
    expect((await request(app).post('/recovery/complete').set(bearer(token)).send(newQuestions)).status).toBe(403);
  });

  it('honours a denial and expires requests after a day', async () => {
    const admin = await makeAdmin();
    const person = await createPerson();
    await setUp(person);
    const token = await emailLinkToken(person.email);
    await request(app).post('/recovery/requests').set(bearer(token)).send({ kind: 'super' });
    const row = (await db.from('recovery_requests').select('id, ready_at').eq('user_id', person.id).single()).data!;
    expect((Date.parse(row.ready_at) - Date.now()) / 60_000).toBeLessThanOrEqual(20);

    await request(app).post(`/admin/recovery/${row.id}/deny`).set(bearer(admin.token)).set('Cookie', admin.cookie);
    expect((await request(app).get('/recovery/current').set(bearer(token))).body.state).toBe('denied');

    await db
      .from('recovery_requests')
      .update({ requested_at: new Date(Date.now() - 48 * 3_600_000).toISOString() })
      .eq('id', row.id);
    await request(app).post('/recovery/requests').set(bearer(token)).send({ kind: 'normal' });
    await db
      .from('recovery_requests')
      .update({ requested_at: new Date(Date.now() - 25 * 3_600_000).toISOString() })
      .eq('user_id', person.id)
      .eq('status', 'pending');
    expect((await request(app).get('/recovery/current').set(bearer(token))).body.state).toBe('expired');
  });
});
