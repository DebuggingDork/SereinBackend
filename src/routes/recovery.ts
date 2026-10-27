import { Router } from 'express';
import { HttpError } from '../lib/errors.js';
import { GATE_COOKIE, passCookieOptions } from '../lib/gatePass.js';
import { authOf, requireAuth } from '../middleware/auth.js';
import { limiter, validateBody } from '../middleware/common.js';
import { openGateSession, replaceQuestions } from '../services/gate.js';
import { completeRequest, createRequest, getCurrent, hasRecentEmailProof } from '../services/recovery.js';
import { questionSetSchema, recoveryRequestSchema } from './schemas.js';

export const recoveryRouter = Router();

recoveryRouter.use(requireAuth);

recoveryRouter.get('/current', limiter(5, 120), async (req, res) => {
  const { userId, amr } = authOf(req);
  res.json({ ...(await getCurrent(userId)), emailConfirmed: hasRecentEmailProof(amr) });
});

// Only a session freshly created from an email link may start a request.
recoveryRouter.post('/requests', limiter(60, 10), validateBody(recoveryRequestSchema), async (req, res) => {
  const { userId, email, amr } = authOf(req);
  if (!hasRecentEmailProof(amr)) {
    throw new HttpError(403, 'Confirm your email first.', { code: 'email_unconfirmed' });
  }
  res.status(201).json(await createRequest(userId, email, req.body.kind));
});

recoveryRouter.post('/complete', limiter(15, 10), validateBody(questionSetSchema), async (req, res) => {
  const { userId, sessionId } = authOf(req);
  await completeRequest(userId);
  await replaceQuestions(userId, req.body.questions);
  res.cookie(GATE_COOKIE, await openGateSession(userId, sessionId), passCookieOptions());
  res.json({ ok: true });
});
