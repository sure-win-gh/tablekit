// List API keys for the operator dashboard.
//
// Run via withUser so the `api_keys_member_read` RLS policy scopes
// the result to the caller's organisation. We never return the
// `hash` column — there's no operational reason to expose it on the
// list page, and keeping it server-side reduces the blast radius of
// a future serialisation bug that leaks props into the client bundle.

import "server-only";

import { desc, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import * as schema from "@/lib/db/schema";
import { apiKeys } from "@/lib/db/schema";

type Db = NodePgDatabase<typeof schema>;

export type ApiKeyRow = {
  id: string;
  prefix: string;
  label: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
};

export async function loadApiKeys(db: Db, orgId: string): Promise<ApiKeyRow[]> {
  return db
    .select({
      id: apiKeys.id,
      prefix: apiKeys.prefix,
      label: apiKeys.label,
      createdAt: apiKeys.createdAt,
      lastUsedAt: apiKeys.lastUsedAt,
      revokedAt: apiKeys.revokedAt,
    })
    .from(apiKeys)
    .where(eq(apiKeys.organisationId, orgId))
    .orderBy(desc(apiKeys.createdAt))
    .limit(200);
}
