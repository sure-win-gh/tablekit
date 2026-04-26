// Covers report — bookings + party size aggregated by venue-local day
// and service. The day bucket is computed in Postgres with
// `start_at AT TIME ZONE <venue-tz>` so a booking right around midnight
// lands on the operator's calendar day, not UTC's.
//
// Returned rows are sorted by day then service name. Empty days are
// not synthesised — the consumer (page or CSV writer) fills gaps if
// it wants a continuous chart axis.

import "server-only";

import { and, asc, eq, gte, lt, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { bookings, services } from "@/lib/db/schema";
import type * as schema from "@/lib/db/schema";

import type { Bounds, CoversRow } from "./types";

type Db = NodePgDatabase<typeof schema>;

export async function getCoversReport(
  db: Db,
  venueId: string,
  bounds: Bounds,
): Promise<CoversRow[]> {
  const rows = await db
    .select({
      day: sql<string>`(${bookings.startAt} AT TIME ZONE ${bounds.timezone})::date::text`.as("day"),
      serviceId: bookings.serviceId,
      serviceName: services.name,
      bookings: sql<number>`count(*)::int`.as("bookings"),
      coversBooked: sql<number>`coalesce(sum(${bookings.partySize}), 0)::int`.as("coversBooked"),
      coversRealised:
        sql<number>`coalesce(sum(${bookings.partySize}) filter (where ${bookings.status} in ('confirmed','seated','finished')), 0)::int`.as(
          "coversRealised",
        ),
    })
    .from(bookings)
    .innerJoin(services, eq(services.id, bookings.serviceId))
    .where(
      and(
        eq(bookings.venueId, venueId),
        gte(bookings.startAt, bounds.startUtc),
        lt(bookings.startAt, bounds.endUtc),
      ),
    )
    .groupBy(sql`1`, bookings.serviceId, services.name)
    .orderBy(asc(sql`1`), asc(services.name));

  return rows;
}
