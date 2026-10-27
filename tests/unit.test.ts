import { describe, expect, it } from 'vitest';
import { hashAnswer, normalizeAnswer, verifyAnswer } from '../src/lib/answers.js';
import { chooseQuestion } from '../src/services/gate.js';
import { hasRecentEmailProof, publicView } from '../src/services/recovery.js';
import { roastFor } from '../src/services/roasts.js';

describe('answers', () => {
  it('ignores capitals and extra spaces', () => {
    expect(normalizeAnswer('  My   Dog ')).toBe('my dog');
  });

  it('verifies a normalised match and rejects anything else', async () => {
    const stored = await hashAnswer('Serein Street');
    expect(stored).not.toContain('serein');
    expect(await verifyAnswer(stored, ' serein   STREET ')).toBe(true);
    expect(await verifyAnswer(stored, 'another street')).toBe(false);
  });

  it('salts each hash uniquely', async () => {
    expect(await hashAnswer('same')).not.toBe(await hashAnswer('same'));
  });
});

describe('chooseQuestion', () => {
  const questions = [
    { id: 'a', last_asked_at: '2026-01-02T00:00:00Z' },
    { id: 'b', last_asked_at: '2026-01-01T00:00:00Z' },
    { id: 'c', last_asked_at: null },
  ];

  it('never repeats the question asked last when there is a choice', () => {
    for (let i = 0; i < 50; i++) expect(chooseQuestion(questions).id).not.toBe('a');
  });

  it('rotates away from an explicitly excluded question', () => {
    for (let i = 0; i < 50; i++) expect(chooseQuestion(questions, 'b').id).not.toBe('b');
  });

  it('still works with a single question', () => {
    const [only] = questions;
    expect(chooseQuestion([only!], only!.id).id).toBe('a');
  });
});

describe('roasts', () => {
  it('follows the scripted order, then keeps roasting', () => {
    expect(roastFor(1)).toBe('Nope. Nice try, detective.');
    expect(roastFor(2)).toContain('Still wrong');
    expect(roastFor(3)).toContain('Use your brain');
    expect(roastFor(4).length).toBeGreaterThan(0);
  });
});

describe('recovery', () => {
  const row = {
    id: '1',
    kind: 'normal' as const,
    requested_at: '2026-01-01T00:00:00Z',
    ready_at: '2026-01-01T01:30:00Z',
  };

  it('never reveals approval to the user', () => {
    expect(publicView({ ...row, status: 'pending' }).state).toBe('waiting');
    expect(publicView({ ...row, status: 'approved' }).state).toBe('waiting');
    expect(publicView({ ...row, status: 'ready' }).state).toBe('ready');
    expect(JSON.stringify(publicView({ ...row, status: 'approved' }))).not.toMatch(/approv|admin/i);
  });

  it('accepts only a recent proof of email ownership', () => {
    const now = Date.now();
    const at = (minutesAgo: number) => (now - minutesAgo * 60_000) / 1000;
    expect(hasRecentEmailProof([{ method: 'otp', timestamp: at(5) }], now)).toBe(true);
    expect(hasRecentEmailProof([{ method: 'otp', timestamp: at(60) }], now)).toBe(false);
    expect(hasRecentEmailProof([{ method: 'password', timestamp: at(1) }], now)).toBe(false);
  });
});
