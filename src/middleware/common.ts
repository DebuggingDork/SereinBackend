import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { HttpError } from '../lib/errors.js';

export function validateBody<T extends z.ZodType>(schema: T): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const first = result.error.issues[0];
      throw new HttpError(400, first?.message ?? 'That request does not look right.');
    }
    req.body = result.data;
    next();
  };
}

// Limits by user once known, otherwise by address. Runs after auth where possible
// so a shared connection does not lock out innocent people.
export function limiter(windowMinutes: number, max: number) {
  return rateLimit({
    windowMs: windowMinutes * 60 * 1000,
    limit: max,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: (req) => req.auth?.userId ?? ipKeyGenerator(req.ip ?? 'unknown'),
    message: { error: 'Too many requests. Give it a minute.' },
  });
}

// Runs before authentication, so a flood of bad tokens never reaches the auth server. It
// counts by address alone and is generous, since people can share one.
export function addressLimiter() {
  return limiter(5, 600);
}

export const notFound: RequestHandler = () => {
  throw new HttpError(404, 'Not found.');
};

export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  if (error instanceof HttpError) {
    res.status(error.status).json({ error: error.message, ...error.details });
    return;
  }
  // Body parser and routing errors carry their own 4xx, and their messages quote the input.
  const status = (error as { status?: unknown }).status;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    res.status(status).json({ error: status === 413 ? 'That is too much at once.' : 'That request does not look right.' });
    return;
  }
  console.error(`[error] ${req.method} ${req.path}`, error);
  res.status(500).json({ error: 'Something went wrong on our side.' });
};
