import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),

  SUPABASE_URL: z.url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),

  // Base64-encoded PKCS8 PEM. The matching public key lives on the frontend, so
  // pages can verify a pass without being able to mint one.
  GATE_PASS_PRIVATE_KEY: z.string().min(20),
  GATE_PASS_TTL_HOURS: z.coerce.number().positive().max(72).default(8),

  // Comma-separated, so previews and production can both be allowed.
  FRONTEND_ORIGIN: z.string().default('http://localhost:3000'),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(1),

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  MAIL_FROM: z.string().default('Serein <no-reply@serein.app>'),
  OWNER_NOTIFY_EMAIL: z.email().optional().or(z.literal('').transform(() => undefined)),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const problems = parsed.error.issues.map((issue) => `  ${issue.path.join('.')}: ${issue.message}`);
  throw new Error(`Invalid environment:\n${problems.join('\n')}`);
}

export const env = parsed.data;
export const isProduction = env.NODE_ENV === 'production';
export const allowedOrigins = env.FRONTEND_ORIGIN.split(',').map((origin) => origin.trim());
