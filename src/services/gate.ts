import { randomInt } from 'node:crypto';
import { verifyAnswer, hashAnswer } from '../lib/answers.js';
import { HttpError, maybe, must } from '../lib/errors.js';
import { issuePass, passLifetimeMs } from '../lib/gatePass.js';
import { db } from '../lib/supabase.js';
import { MISSES_BEFORE_COOLDOWN, roastFor } from './roasts.js';

interface StoredQuestion {
  id: string;
  question: string;
  answer_hash: string;
  last_asked_at: string | null;
}

export interface QuestionInput {
  question: string;
  answer: string;
}

async function loadQuestions(userId: string): Promise<StoredQuestion[]> {
  return must(
    await db
      .from('security_questions')
      .select('id, question, answer_hash, last_asked_at')
      .eq('user_id', userId),
  );
}

interface Claim {
  claimed: boolean;
  current_question_id: string | null;
  failed_count: number;
  locked_until: string | null;
}

// Each guess takes the user's single slot before the slow comparison, so parallel requests
// cannot all test an answer against the same question before a miss is recorded.
async function claimAttempt(userId: string): Promise<Claim | null> {
  const rows = must(await db.rpc('gate_claim_attempt', { p_user_id: userId })) as Claim[];
  return rows[0] ?? null;
}

async function loadState(userId: string) {
  return maybe(
    await db
      .from('gate_state')
      .select('current_question_id, failed_count, locked_until')
      .eq('user_id', userId)
      .maybeSingle(),
  );
}

async function releaseAttempt(userId: string) {
  must(await db.from('gate_state').update({ verifying_until: null }).eq('user_id', userId));
}

// Picks at random, skipping the question asked last whenever there is a choice.
export function chooseQuestion<T extends Pick<StoredQuestion, 'id' | 'last_asked_at'>>(
  questions: T[],
  excludeId?: string | null,
): T {
  const lastAsked = questions
    .filter((q) => q.last_asked_at)
    .sort((a, b) => Date.parse(b.last_asked_at!) - Date.parse(a.last_asked_at!))[0];
  const avoid = excludeId ?? lastAsked?.id;
  const pool = questions.length > 1 ? questions.filter((q) => q.id !== avoid) : questions;
  return pool[randomInt(pool.length)] as T;
}

async function putQuestionOnTable(userId: string, question: StoredQuestion) {
  must(
    await db
      .from('gate_state')
      .upsert({ user_id: userId, current_question_id: question.id }, { onConflict: 'user_id' }),
  );
  must(
    await db
      .from('security_questions')
      .update({ last_asked_at: new Date().toISOString() })
      .eq('id', question.id),
  );
}

function activeLock(lockedUntil: string | null | undefined): string | null {
  return lockedUntil && Date.parse(lockedUntil) > Date.now() ? lockedUntil : null;
}

export type GateChallenge =
  | { state: 'setup' }
  | { state: 'locked'; lockedUntil: string; attempt: number; maxAttempts: number }
  | { state: 'challenge'; question: string; attempt: number; maxAttempts: number };

// The question stays on the table until answered, so reloading the page cannot be
// used to shop for an easier one.
export async function getChallenge(userId: string): Promise<GateChallenge> {
  const questions = await loadQuestions(userId);
  if (questions.length === 0) return { state: 'setup' };

  const state = await loadState(userId);
  const attempt = state?.failed_count ?? 0;
  const lockedUntil = activeLock(state?.locked_until);
  if (lockedUntil) {
    return { state: 'locked', lockedUntil, attempt, maxAttempts: MISSES_BEFORE_COOLDOWN };
  }

  let current = questions.find((q) => q.id === state?.current_question_id);
  if (!current) {
    current = chooseQuestion(questions);
    await putQuestionOnTable(userId, current);
  }
  return { state: 'challenge', question: current.question, attempt, maxAttempts: MISSES_BEFORE_COOLDOWN };
}

// Records a live gate session, which row-level security checks on every query.
export async function openGateSession(userId: string, sessionId: string): Promise<string> {
  must(
    await db.from('gate_sessions').upsert({
      session_id: sessionId,
      user_id: userId,
      expires_at: new Date(Date.now() + passLifetimeMs()).toISOString(),
    }),
  );
  return issuePass(userId, sessionId);
}

export async function closeGateSession(sessionId: string): Promise<void> {
  must(await db.from('gate_sessions').delete().eq('session_id', sessionId));
}

export type VerifyResult =
  | { ok: true; pass: string }
  | {
      ok: false;
      roast: string;
      question: string | null;
      attempt: number;
      maxAttempts: number;
      lockedUntil: string | null;
    };

export async function verify(
  userId: string,
  sessionId: string,
  answer: string,
  ip: string | undefined,
): Promise<VerifyResult> {
  const questions = await loadQuestions(userId);
  if (questions.length === 0) throw new HttpError(409, 'Set up your questions first.', { code: 'setup_required' });

  const claim = await claimAttempt(userId);
  const lockedUntil = activeLock(claim?.locked_until);
  if (lockedUntil) {
    throw new HttpError(429, 'Take a break. Think harder.', {
      code: 'locked',
      lockedUntil,
      attempt: claim?.failed_count ?? 0,
      maxAttempts: MISSES_BEFORE_COOLDOWN,
    });
  }
  const current = questions.find((q) => q.id === claim?.current_question_id);
  if (claim && !claim.claimed) {
    throw new HttpError(429, 'One moment, still checking your last answer.', { code: 'busy' });
  }
  if (!current) {
    await releaseAttempt(userId);
    throw new HttpError(409, 'That question has moved on. Try again.', { code: 'no_challenge' });
  }

  const correct = await verifyAnswer(current.answer_hash, answer);

  must(
    await db.from('gate_attempts').insert({
      user_id: userId,
      success: correct,
      ip: ip ?? null,
      question_id: current.id,
      question_text: current.question,
    }),
  );

  if (correct) {
    must(
      await db
        .from('gate_state')
        .update({
          current_question_id: null,
          failed_count: 0,
          locked_until: null,
          last_failed_at: null,
          verifying_until: null,
        })
        .eq('user_id', userId),
    );
    return { ok: true, pass: await openGateSession(userId, sessionId) };
  }

  // Every miss rotates the question, so one answer cannot be brute-forced. The new question
  // goes on the table first, because recording the miss is what frees the slot.
  const next = chooseQuestion(questions, current.id);
  await putQuestionOnTable(userId, next);

  const failure = must(await db.rpc('gate_register_failure', { p_user_id: userId }).single()) as {
    failed_count: number;
    locked_until: string | null;
  };

  return {
    ok: false,
    roast: roastFor(failure.failed_count),
    question: failure.locked_until ? null : next.question,
    attempt: failure.failed_count,
    maxAttempts: MISSES_BEFORE_COOLDOWN,
    lockedUntil: failure.locked_until,
  };
}

export async function hasQuestions(userId: string): Promise<boolean> {
  const { count, error } = await db
    .from('security_questions')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId);
  if (error) throw new Error(error.message);
  return (count ?? 0) > 0;
}

export function hashQuestions(questions: QuestionInput[]) {
  return Promise.all(
    questions.map(async ({ question, answer }) => ({
      question: question.trim(),
      answer_hash: await hashAnswer(answer),
    })),
  );
}

export async function replaceQuestions(userId: string, questions: QuestionInput[]): Promise<void> {
  must(await db.rpc('replace_security_questions', { p_user_id: userId, p_questions: await hashQuestions(questions) }));
}

export async function listQuestionTexts(userId: string) {
  return must(
    await db
      .from('security_questions')
      .select('id, question, last_asked_at, created_at')
      .eq('user_id', userId)
      .order('created_at'),
  );
}
