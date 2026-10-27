import { Router } from 'express';
import { HttpError } from '../lib/errors.js';
import { GATE_COOKIE, passCookieOptions } from '../lib/gatePass.js';
import { authOf, requireAuth, requireSession } from '../middleware/auth.js';
import { addressLimiter, limiter, validateBody } from '../middleware/common.js';
import { openGateSession } from '../services/gate.js';
import { completeWithQuestions, createRequest, getCurrent, hasRecentEmailProof } from '../services/recovery.js';
import { questionSetSchema, recoveryRequestSchema } from './schemas.js';

export const recoveryRouter = Router();

recoveryRouter.use(addressLimiter());

recoveryRouter.get('/current', requireSession, limiter(5, 120), async (req, res) => {
  const { userId, amr } = authOf(req);
  res.json({ ...(await getCurrent(userId)), emailConfirmed: hasRecentEmailProof(amr) });
});

// Only a session freshly created from an email link may start a request.
recoveryRouter.post('/requests', requireAuth, limiter(60, 10), validateBody(recoveryRequestSchema), async (req, res) => {
  const { userId, email, amr } = authOf(req);
  if (!hasRecentEmailProof(amr)) {
    throw new HttpError(403, 'Confirm your email first.', { code: 'email_unconfirmed' });
  }
  res.status(201).json(await createRequest(userId, email, req.body.kind));
});

recoveryRouter.post('/complete', requireAuth, limiter(15, 10), validateBody(questionSetSchema), async (req, res) => {
  const { userId, sessionId } = authOf(req);
  await completeWithQuestions(userId, req.body.questions);
  res.cookie(GATE_COOKIE, await openGateSession(userId, sessionId), passCookieOptions());
  res.json({ ok: true });
});
