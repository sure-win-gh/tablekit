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

import { databaseUrlFor } from "@/lib/regions/config";
import { DEFAULT_REGION, type Region } from "@/lib/regions/mapping";

import * as schema from "../../db/schema";

// One service-role pool per region (docs/specs/multi-region.md, Phase 1).
// URL resolution + the fail-closed unset-US behaviour live in
// lib/regions/config.ts.
const _pools = new Map<Region, Pool>();

function pool(region: Region): Pool {
  const existing = _pools.get(region);
  if (existing) return existing;
  const created = new Pool({ connectionString: databaseUrlFor(region), max: 5 });
  _pools.set(region, created);
  return created;
}

/**
 * `region` picks which regional database this service-role client
 * targets. Defaults to `eu` — every existing caller resolves there
 * until Phase 3 lands, so behaviour is unchanged.
 */
export function adminDb(region: Region = DEFAULT_REGION): NodePgDatabase<typeof schema> {
  return drizzle(pool(region), { schema });
}
