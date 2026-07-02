// Peak times — realised traffic bucketed by venue-local weekday × hour.
// Powers the reports heatmap so an operator can see busy/quiet patterns
// at a glance (e.g. "Thursday 19:00 is rammed, Tuesday lunch is dead").
//
// Realised statuses only (confirmed|seated|finished): the heatmap is a
// "when are we actually busy" view, so cancellations and no-shows would
// only add noise. Empty cells are not synthesised — the client grid
// zero-fills for a stable 7×24 axis.

import "server-only";

import { and, asc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { bookings } from "@/lib/db/schema";
import type * as schema from "@/lib/db/schema";

import type { Bounds, PeakTimeCell } from "./types";

type Db = NodePgDatabase<typeof schema>;

export async function getPeakTimesReport(
  db: Db,
  venueId: string,
  bounds: Bounds,
): Promise<PeakTimeCell[]> {
  const rows = await db
    .select({
      weekday:
        sql<number>`extract(isodow from ${bookings.startAt} AT TIME ZONE ${bounds.timezone})::int`.as(
          "weekday",
        ),
      hour: sql<number>`extract(hour from ${bookings.startAt} AT TIME ZONE ${bounds.timezone})::int`.as(
        "hour",
      ),
      bookings: sql<number>`count(*)::int`.as("bookings"),
      covers: sql<number>`coalesce(sum(${bookings.partySize}), 0)::int`.as("covers"),
    })
    .from(bookings)
    .where(
      and(
        eq(bookings.venueId, venueId),
        gte(bookings.startAt, bounds.startUtc),
        lt(bookings.startAt, bounds.endUtc),
        inArray(bookings.status, ["confirmed", "seated", "finished"]),
      ),
    )
    .groupBy(sql`1`, sql`2`)
    .orderBy(asc(sql`1`), asc(sql`2`));

  return rows;
}
