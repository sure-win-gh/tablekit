// Service-role Supabase client for privileged auth operations.
//
// SERVER-ONLY, and deliberately under lib/server/admin/ (the only place the
// service_role key may be used — enforced by .claude/hooks/guard-pii.js).
// The service_role key bypasses RLS and can mutate any user, so it must
// never be imported by client code. Used only by the password-reset action
// to set a new password (`auth.admin.updateUserById`). For domain-table
// writes use adminDb() (./db.ts); for request-bound auth use
// supabaseServer() (lib/db/supabase-server.ts).

import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

function requireRealEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.includes("YOUR_")) {
    throw new Error(
      `lib/server/admin/supabase-admin.ts: ${name} is not set. See .env.local.example.`,
    );
  }
  return value;
}

/**
 * Build a service-role Supabase client. No session persistence or token
 * auto-refresh — it's a one-shot admin client per call. Throws if the
 * service-role key is missing/placeholder so callers fail closed.
 */
export function supabaseAdmin(): SupabaseClient {
  return createClient(
    requireRealEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireRealEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}
