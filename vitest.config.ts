import { generateKeyPairSync } from 'node:crypto';
import { defineConfig } from 'vitest/config';

const { privateKey } = generateKeyPairSync('ed25519', {
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

export default defineConfig({
  test: {
    env: {
      NODE_ENV: 'test',
      TRUST_PROXY_HOPS: '1',
      JOBS_SECRET: 'test-jobs-secret-that-is-long-enough',
      SUPABASE_URL: process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321',
      SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY ?? 'test-key-that-is-long-enough',
      GATE_PASS_PRIVATE_KEY: process.env.GATE_PASS_PRIVATE_KEY ?? Buffer.from(privateKey).toString('base64'),
    },
    testTimeout: 30_000,
  },
});
