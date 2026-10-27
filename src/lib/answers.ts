import { hash, verify } from '@node-rs/argon2';

// "  My   Dog " and "my dog" are the same answer.
export function normalizeAnswer(answer: string): string {
  return answer.normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' ');
}

// Argon2id with a unique random salt per answer.
export function hashAnswer(answer: string): Promise<string> {
  return hash(normalizeAnswer(answer));
}

export function verifyAnswer(storedHash: string, answer: string): Promise<boolean> {
  return verify(storedHash, normalizeAnswer(answer));
}
