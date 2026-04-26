// Top returning guests — counted by realised visits (confirmed,
// seated, finished) within the range. Cancelled / no-show bookings
// don't earn a "visit". Min visits = 2 — a single booking isn't
// "returning".
//
// Only `first_name` is exposed here — last name + email live behind
// envelope encryption. The dashboard already has a guest-detail page
// that decrypts via `lib/security/crypto.ts`; for CSV export we link
// out to that page rather than dumping decrypted PII into a file.

import "server-only";

import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { bookings, guests } from "@/lib/db/schema";
import type * as schema from "@/lib/db/schema";

import type { Bounds, TopGuestRow } from "./types";

type Db = NodePgDatabase<typeof schema>;

const REALISED = ["confirmed", "seated", "finished"] as const;

export async function getTopGuestsReport(
  db: Db,
  venueId: string,
  bounds: Bounds,
  limit = 50,
): Promise<TopGuestRow[]> {
  const rows = await db
    .select({
      guestId: guests.id,
      firstName: guests.firstName,
      visits: sql<number>`count(*)::int`.as("visits"),
      lastVisit: sql<Date>`max(${bookings.startAt})`.as("lastVisit"),
    })
    .from(bookings)
    .innerJoin(guests, eq(guests.id, bookings.guestId))
    .where(
      and(
        eq(bookings.venueId, venueId),
        gte(bookings.startAt, bounds.startUtc),
        lt(bookings.startAt, bounds.endUtc),
        inArray(bookings.status, [...REALISED]),
      ),
    )
    .groupBy(guests.id, guests.firstName)
    .having(sql`count(*) >= 2`)
    .orderBy(desc(sql`count(*)`), desc(sql`max(${bookings.startAt})`))
    .limit(limit);

  return rows;
}
