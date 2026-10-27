import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { expect } from 'vitest';
import { createApp } from '../src/app.js';
import { db } from '../src/lib/supabase.js';

// Integration tests run against a local Supabase stack. `supabase start`, then set
// SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY. They are skipped otherwise.
export const anonKey = process.env.SUPABASE_ANON_KEY;
const url = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321';
export const app = createApp();
const PASSWORD = 'correct-horse-battery';

export interface Person {
  id: string;
  email: string;
  client: SupabaseClient;
  token: string;
}

export function browserClient(token?: string) {
  return createClient(url, anonKey!, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
  });
}

export async function createPerson(): Promise<Person> {
  const email = `${randomUUID()}@serein.test`;
  const { data, error } = await db.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error) throw error;
  const session = await signIn(email);
  return { id: data.user.id, email, client: browserClient(session), token: session };
}

export async function signIn(email: string): Promise<string> {
  const { data, error } = await browserClient().auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw error;
  return data.session.access_token;
}

export async function emailLinkToken(email: string): Promise<string> {
  const { data, error } = await db.auth.admin.generateLink({ type: 'magiclink', email });
  if (error) throw error;
  const { data: verified, error: verifyError } = await browserClient().auth.verifyOtp({
    token_hash: data.properties.hashed_token,
    type: 'magiclink',
  });
  if (verifyError) throw verifyError;
  return verified.session!.access_token;
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
export const passCookie = (res: request.Response) =>
  (res.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;

export const QUESTIONS = [
  { question: 'First street you lived on?', answer: 'Serein Street' },
  { question: 'Name of your first pet?', answer: 'Biscuit' },
  { question: 'Favourite teacher?', answer: 'Mrs Rao' },
];
export const answerTo = (question: string) => QUESTIONS.find((q) => q.question === question)!.answer;

export async function setUp(person: Person) {
  const res = await request(app).post('/gate/setup').set(bearer(person.token)).send({ questions: QUESTIONS });
  expect(res.status).toBe(201);
  return passCookie(res);
}

export async function passGate(token: string) {
  const challenge = await request(app).get('/gate/challenge').set(bearer(token));
  const res = await request(app)
    .post('/gate/verify')
    .set(bearer(token))
    .send({ answer: answerTo(challenge.body.question) });
  expect(res.body.ok).toBe(true);
  return passCookie(res);
}
