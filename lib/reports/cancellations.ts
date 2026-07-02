// Cancellations report — rate, per-day trend, and reason breakdown.
// Bucketed by the booking's slot day (start_at in the venue's zone),
// consistent with the covers report, so "cancellations on the 14th"
// means bookings *for* the 14th that were cancelled, wherever the
// cancel click happened in time.
//
// Reason strings are UNCONSTRAINED free text (dashboard ≤200 chars,
// public API ≤500 — no enum exists), grouped verbatim; NULL/blank is
// reported as "unspecified" so the breakdown always sums to the
// cancelled total. Because operators can type anything here, the
// cancel dialog warns against guest-identifying detail — see
// docs/playbooks/gdpr.md §Encryption (operator free-text rule).

import "server-only";

import { and, asc, desc, eq, gte, lt, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { bookings } from "@/lib/db/schema";
import type * as schema from "@/lib/db/schema";

import type { Bounds, CancellationsReport } from "./types";

type Db = NodePgDatabase<typeof schema>;

export async function getCancellationsReport(
  db: Db,
  venueId: string,
  bounds: Bounds,
): Promise<CancellationsReport> {
  const inRange = and(
    eq(bookings.venueId, venueId),
    gte(bookings.startAt, bounds.startUtc),
    lt(bookings.startAt, bounds.endUtc),
  );

  const byDay = await db
    .select({
      day: sql<string>`(${bookings.startAt} AT TIME ZONE ${bounds.timezone})::date::text`.as("day"),
      bookings: sql<number>`count(*)::int`.as("bookings"),
      cancelled: sql<number>`count(*) filter (where ${bookings.status} = 'cancelled')::int`.as(
        "cancelled",
      ),
    })
    .from(bookings)
    .where(inRange)
    .groupBy(sql`1`)
    .orderBy(asc(sql`1`));

  const byReason = await db
    .select({
      reason:
        sql<string>`coalesce(nullif(trim(${bookings.cancelledReason}), ''), 'unspecified')`.as(
          "reason",
        ),
      count: sql<number>`count(*)::int`.as("count"),
    })
    .from(bookings)
    .where(and(inRange, eq(bookings.status, "cancelled")))
    .groupBy(sql`1`)
    .orderBy(desc(sql`count(*)`), asc(sql`1`));

  const totalBookings = byDay.reduce((sum, r) => sum + r.bookings, 0);
  const cancelled = byDay.reduce((sum, r) => sum + r.cancelled, 0);

  return {
    totalBookings,
    cancelled,
    rate: totalBookings === 0 ? 0 : cancelled / totalBookings,
    byDay,
    byReason,
  };
}
