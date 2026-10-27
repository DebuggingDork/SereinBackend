import { createClient } from '@supabase/supabase-js';
import { env } from '../config/env.js';

// Service-role client: bypasses row-level security, so it must never leave this
// process and every query through it has to filter by user explicitly.
export const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
