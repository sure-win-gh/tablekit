// Source mix — bookings + covers grouped by `bookings.source`.
// Sources today: 'host' (operator-created), 'widget' (public widget),
// 'walk-in' (waitlist seat-now), and the future 'rwg' / 'api' values.
//
// Cancelled bookings are included — operators want to see "the widget
// produced 200 enquiries even if 30 cancelled" as a top-of-funnel
// signal. The covers number is `sum(party_size)` regardless of status.

import "server-only";

import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { bookings } from "@/lib/db/schema";
import type * as schema from "@/lib/db/schema";

import type { Bounds, SourceMixRow } from "./types";

type Db = NodePgDatabase<typeof schema>;

export async function getSourceMixReport(
  db: Db,
  venueId: string,
  bounds: Bounds,
): Promise<SourceMixRow[]> {
  const rows = await db
    .select({
      source: bookings.source,
      bookings: sql<number>`count(*)::int`.as("bookings"),
      covers: sql<number>`coalesce(sum(${bookings.partySize}), 0)::int`.as("covers"),
    })
    .from(bookings)
    .where(
      and(
        eq(bookings.venueId, venueId),
        gte(bookings.startAt, bounds.startUtc),
        lt(bookings.startAt, bounds.endUtc),
      ),
    )
    .groupBy(bookings.source)
    .orderBy(desc(sql`count(*)`));

  return rows;
}
