// Shared guest-list query for the operator CRM views.
//
// Two callers today:
//   - /dashboard/guests              → cross-venue (org-scoped, all venues)
//   - /dashboard/venues/[id]/guests  → per-venue   (filtered to one venue)
//
// Guests live at the organisation level (no venue_id column on guests
// — see schema.ts:298) so per-venue scoping is a query-level filter
// over `bookings`, which carries both guestId and venueId. The org
// branch is the original query the cross-venue page used inline; the
// venue branch narrows the join to bookings at the requested venue,
// then EXISTS-filters out guests with zero bookings here. RLS on
// `guests` (org-level) and `bookings` (venue-level via memberships)
// applies whenever the caller passes a withUser-bound db.
//
// PII discipline: this is a list-shape query — first_name is plaintext
// per schema, all other selected columns are non-PII aggregates. No
// decryption happens here. The detail page at
// /dashboard/guests/[guestId] handles per-row decryption when a row
// is opened.
//
// API shape mirrors lib/export/guests.ts: the caller passes their own
// db handle (usually obtained via `withUser`), keeping this module
// transport-agnostic and integration-testable without a Supabase
// session.

import "server-only";

import { and, desc, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import * as schema from "@/lib/db/schema";
import { bookings, guests } from "@/lib/db/schema";

type Db = NodePgDatabase<typeof schema>;

export type GuestListRow = {
  id: string;
  firstName: string;
  createdAt: Date;
  visits: number;
  // Distinct venues this guest has booked at within the org. Always 1
  // in the venue-scoped branch (only that venue's bookings are joined),
  // so callers should treat it as meaningful only in cross-venue mode.
  venuesVisited: number;
  lastVisit: Date | null;
};

const REALISED = sql`(${bookings.status} in ('confirmed','seated','finished'))`;

export async function loadOrgGuests(
  db: Db,
  args: { orgId: string; venueId?: string },
): Promise<GuestListRow[]> {
  const { orgId, venueId } = args;

  const joinCondition = venueId
    ? and(eq(bookings.guestId, guests.id), eq(bookings.venueId, venueId))
    : eq(bookings.guestId, guests.id);

  const whereParts = [eq(guests.organisationId, orgId)];
  if (venueId) {
    // Belt-and-braces: the join above already restricts aggregates to
    // this venue, but EXISTS rejects guests with zero bookings here
    // (otherwise a left-join would surface them with zero visits). RLS
    // still wraps both reads when the caller's db is withUser-bound.
    whereParts.push(
      sql`exists (select 1 from ${bookings} b where b.guest_id = ${guests.id} and b.venue_id = ${venueId})`,
    );
  }

  const rows = await db
    .select({
      id: guests.id,
      firstName: guests.firstName,
      createdAt: guests.createdAt,
      visits: sql<number>`coalesce(count(${bookings.id}) filter (where ${REALISED}), 0)::int`.as(
        "visits",
      ),
      venuesVisited: sql<number>`coalesce(count(distinct ${bookings.venueId}), 0)::int`.as(
        "venuesVisited",
      ),
      // node-postgres returns max(timestamptz) as a string for raw sql
      // expressions (drizzle's auto-parser only fires on declared
      // timestamp columns). Cast at the boundary below.
      lastVisit: sql<string | null>`max(${bookings.startAt}) filter (where ${REALISED})`.as(
        "lastVisit",
      ),
    })
    .from(guests)
    .leftJoin(bookings, joinCondition)
    .where(and(...whereParts))
    .groupBy(guests.id, guests.firstName, guests.createdAt)
    .orderBy(desc(sql`max(${bookings.startAt})`), desc(guests.createdAt))
    .limit(200);

  return rows.map((g) => ({
    id: g.id,
    firstName: g.firstName,
    createdAt: g.createdAt,
    visits: g.visits,
    venuesVisited: g.venuesVisited,
    lastVisit: g.lastVisit ? new Date(g.lastVisit) : null,
  }));
}
