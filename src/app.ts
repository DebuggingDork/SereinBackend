import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { allowedOrigins, env } from './config/env.js';
import { errorHandler, notFound } from './middleware/common.js';
import { adminRouter } from './routes/admin.js';
import { gateRouter } from './routes/gate.js';
import { healthRouter } from './routes/health.js';
import { recoveryRouter } from './routes/recovery.js';

export function createApp() {
  const app = express();

  app.set('trust proxy', env.TRUST_PROXY_HOPS);
  app.disable('x-powered-by');

  app.use(helmet());
  app.use(cors({ origin: allowedOrigins, credentials: true }));
  app.use(express.json({ limit: '32kb' }));
  app.use(cookieParser());

  app.use(healthRouter);
  app.use('/gate', gateRouter);
  app.use('/recovery', recoveryRouter);
  app.use('/admin', adminRouter);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
