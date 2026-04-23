// service_role Drizzle client — BYPASSES RLS.
//
// Used only for operations that cannot run under RLS:
//   - signup: create organisations / memberships before the user has
//     a membership row proving they can see them
//   - invite accept: create a membership for a user before the user
//     exists in the target org's scope
//   - audit_log insert: writes must succeed regardless of the caller's
//     session (we want to log failed auth attempts too)
//   - scheduled jobs: GDPR erasure scrubs, retention cleanups
//
// Import ONLY from other modules under lib/server/admin/**. The
// code-reviewer subagent is configured to flag imports from elsewhere.
// See docs/playbooks/security.md §Cross-tenant bugs.
//
// Unlike lib/db/client.ts's authed pool, this uses a service_role
// connection (role 'postgres'/'service_role' depending on how the
// pooler is configured) and NO transaction-level RLS context.

import "server-only";

import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "../../db/schema";

let _pool: Pool | null = null;

function pool(): Pool {
  if (_pool) return _pool;
  const connectionString = process.env["DATABASE_URL"];
  if (!connectionString) {
    throw new Error("lib/server/admin/db.ts: DATABASE_URL is not set. See .env.local.example.");
  }
  _pool = new Pool({ connectionString, max: 5 });
  return _pool;
}

export function adminDb(): NodePgDatabase<typeof schema> {
  return drizzle(pool(), { schema });
}
