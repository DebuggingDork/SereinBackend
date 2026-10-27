import { Router } from 'express';
import { HttpError } from '../lib/errors.js';
import { GATE_COOKIE, passCookieOptions } from '../lib/gatePass.js';
import { authOf, requireAuth, requireFreshPass, requirePass } from '../middleware/auth.js';
import { limiter, validateBody } from '../middleware/common.js';
import {
  closeGateSession,
  getChallenge,
  hasQuestions,
  listQuestionTexts,
  openGateSession,
  replaceQuestions,
  verify,
} from '../services/gate.js';
import { answerSchema, questionSetSchema } from './schemas.js';

export const gateRouter = Router();

gateRouter.use(requireAuth);

gateRouter.get('/challenge', limiter(5, 120), async (req, res) => {
  res.json(await getChallenge(authOf(req).userId));
});

gateRouter.post('/verify', limiter(15, 40), validateBody(answerSchema), async (req, res) => {
  const { userId, sessionId } = authOf(req);
  const result = await verify(userId, sessionId, req.body.answer, req.ip);
  if (result.ok) {
    res.cookie(GATE_COOKIE, result.pass, passCookieOptions());
    res.json({ ok: true });
    return;
  }
  res.status(200).json(result);
});

// First-time setup. Once questions exist, changes go through /questions below.
gateRouter.post('/setup', limiter(15, 20), validateBody(questionSetSchema), async (req, res) => {
  const { userId, sessionId } = authOf(req);
  if (await hasQuestions(userId)) {
    throw new HttpError(409, 'Your questions are already set.', { code: 'already_set' });
  }
  await replaceQuestions(userId, req.body.questions);
  res.cookie(GATE_COOKIE, await openGateSession(userId, sessionId), passCookieOptions());
  res.status(201).json({ ok: true });
});

gateRouter.post('/lock', async (req, res) => {
  await closeGateSession(authOf(req).sessionId);
  res.clearCookie(GATE_COOKIE, { ...passCookieOptions(), maxAge: undefined });
  res.json({ ok: true });
});

gateRouter.get('/questions', requirePass, async (req, res) => {
  res.json({ questions: await listQuestionTexts(authOf(req).userId) });
});

// Replacing questions wants a recent answer, not just a live pass.
gateRouter.put(
  '/questions',
  limiter(15, 20),
  requirePass,
  requireFreshPass(10 * 60),
  validateBody(questionSetSchema),
  async (req, res) => {
    await replaceQuestions(authOf(req).userId, req.body.questions);
    res.json({ ok: true });
  },
);
