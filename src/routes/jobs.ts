import { timingSafeEqual } from 'node:crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { env } from '../config/env.js';
import { HttpError } from '../lib/errors.js';
import { limiter } from '../middleware/common.js';
import { sendDailyReminders } from '../services/reminders.js';

export const jobsRouter = Router();

function secretMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Called by an outside scheduler, because this server sleeps on the free tier. With no
// secret configured the route does not exist.
function requireJobSecret(req: Request, _res: Response, next: NextFunction) {
  const given = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
  if (!env.JOBS_SECRET || !secretMatches(given, env.JOBS_SECRET)) throw new HttpError(404, 'Not found.');
  next();
}

jobsRouter.post('/reminders', limiter(5, 10), requireJobSecret, async (_req, res) => {
  res.json(await sendDailyReminders());
});
