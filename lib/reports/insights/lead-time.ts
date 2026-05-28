// Lead-time histogram — how far in advance diners book.
//
// Range semantics: filter on start_at (the service date) so "April" means
// "bookings for April"; bucket each row by the calendar-day difference
// between start_at and created_at, both projected to the venue's local
// zone so a 23:30 booking placed 30 minutes earlier still counts as
// same-day rather than spilling into "1d" via UTC drift.
//
// Cancelled bookings are excluded — they distort the "how far in advance
// do diners book" question by counting commitments that didn't happen.
//
// Returned rows always include every bucket (zero-filled) so the chart
// never has gaps and the consumer doesn't need to remember the bucket
// order.

import "server-only";

import { and, eq, gte, lt, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { bookings } from "@/lib/db/schema";
import type * as schema from "@/lib/db/schema";

import type { Bounds } from "../types";
import { LEAD_TIME_BUCKETS, type LeadTimeBucket, type LeadTimeRow } from "./types";

type Db = NodePgDatabase<typeof schema>;

export async function getLeadTimeReport(
  db: Db,
  venueId: string,
  bounds: Bounds,
): Promise<LeadTimeRow[]> {
  const daysExpr = sql<number>`(
    (${bookings.startAt} AT TIME ZONE ${bounds.timezone})::date
    - (${bookings.createdAt} AT TIME ZONE ${bounds.timezone})::date
  )`;

  const bucketExpr = sql<LeadTimeBucket>`
    case
      when ${daysExpr} <= 0 then 'same-day'
      when ${daysExpr} = 1 then '1d'
      when ${daysExpr} between 2 and 3 then '2-3d'
      when ${daysExpr} between 4 and 7 then '4-7d'
      when ${daysExpr} between 8 and 14 then '8-14d'
      when ${daysExpr} between 15 and 30 then '15-30d'
      else '30d+'
    end
  `;

  const rows = await db
    .select({
      bucket: bucketExpr.as("bucket"),
      bookings: sql<number>`count(*)::int`.as("bookings"),
      covers: sql<number>`coalesce(sum(${bookings.partySize}), 0)::int`.as("covers"),
    })
    .from(bookings)
    .where(
      and(
        eq(bookings.venueId, venueId),
        gte(bookings.startAt, bounds.startUtc),
        lt(bookings.startAt, bounds.endUtc),
        sql`${bookings.status} <> 'cancelled'`,
      ),
    )
    .groupBy(sql`1`);

  // Zero-fill missing buckets, preserve the canonical ordering so the
  // chart's X axis is stable and the CSV is reproducible.
  const byBucket = new Map(rows.map((r) => [r.bucket, r]));
  return LEAD_TIME_BUCKETS.map((bucket) => {
    const hit = byBucket.get(bucket);
    return {
      bucket,
      bookings: hit?.bookings ?? 0,
      covers: hit?.covers ?? 0,
    };
  });
}
