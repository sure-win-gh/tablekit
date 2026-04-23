// Admin-side helper: resolve a user's first membership and set the
// active-org cookie accordingly. Uses adminDb() because the caller
// typically doesn't have an active org yet — there's nothing for
// withUser's RLS policies to filter against.
//
// During the auth phase every user has exactly one membership (signup
// makes them owner of one fresh org; invites/multi-org arrive in the
// auth-invites phase), so "first membership" is deterministic. Once
// multi-org lands this will need a smarter policy — likely "most
// recently switched to, falling back to oldest membership."

import "server-only";

import { eq } from "drizzle-orm";

import { memberships } from "@/lib/db/schema";
import { setActiveOrg } from "@/lib/auth/active-org";

import { adminDb } from "./db";

export async function establishActiveOrg(userId: string): Promise<string | null> {
  const rows = await adminDb()
    .select({ orgId: memberships.organisationId })
    .from(memberships)
    .where(eq(memberships.userId, userId))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  await setActiveOrg(row.orgId);
  return row.orgId;
}
