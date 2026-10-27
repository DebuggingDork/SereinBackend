import { randomInt } from 'node:crypto';

export const MISSES_BEFORE_COOLDOWN = 4;

const ROASTS_BY_ATTEMPT = [
  'Nope. Nice try, detective.',
  'Still wrong. Are you even the owner of this account?',
  "I'm starting to think you're just guessing. Use your brain.",
];

const COOLDOWN_ROASTS = [
  'Take a break. Think harder.',
  'The door is closed. Go touch some grass.',
  'Sit with your choices for a while.',
  'Even the door is embarrassed for you.',
];

export function roastFor(failedCount: number): string {
  return ROASTS_BY_ATTEMPT[failedCount - 1] ?? pick(COOLDOWN_ROASTS);
}

function pick(options: string[]): string {
  return options[randomInt(options.length)] as string;
}
