// Shared types for admin metric queries.
//
// AdminDb is the same shape as the operator-side reports — Drizzle's
// NodePgDatabase bound to our schema — but here it's expected to be
// the cross-org adminDb() handle.

import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import type * as schema from "@/lib/db/schema";

export type AdminDb = NodePgDatabase<typeof schema>;
