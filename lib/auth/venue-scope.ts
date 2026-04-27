// Per-venue access check for server actions and route handlers.
//
// requireRole() only verifies org membership — it doesn't honour the
// per-venue scoping (memberships.venue_ids) introduced in 0013. For
// any action that touches a venue-scoped resource via adminDb (which
// bypasses RLS), call assertVenueVisible() first so a manager scoped
// to one venue can't operate against another venue in the same org
// by crafting a venue id in the form payload.
//
// Implementation routes the lookup through withUser, which uses the
// authed Postgres role and therefore consults user_visible_venue_ids().

import "server-only";

import { eq } from "drizzle-orm";

import { withUser } from "@/lib/db/client";
import { venues } from "@/lib/db/schema";

export async function assertVenueVisible(venueId: string): Promise<boolean> {
  return withUser(async (db) => {
    const rows = await db
      .select({ id: venues.id })
      .from(venues)
      .where(eq(venues.id, venueId))
      .limit(1);
    return rows.length > 0;
  });
}
