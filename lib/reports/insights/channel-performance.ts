// Channel performance — per-source comparison for the date range.
//
// One row per known booking source (host/widget/walk-in/rwg/api), even
// when a source produced nothing in range: an explicit zero row reads
// "no widget bookings yet" rather than leaving a confusing gap.
//
// Two passes: the main aggregate (counts, party size, lead time — no
// payments) and a payments pass for deposit capture rate. Merged + zero-
// filled in JS, where the rates are computed so the division logic is
// readable and testable.

import "server-only";

import { and, eq, gte, lt, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { bookings, payments } from "@/lib/db/schema";
import type * as schema from "@/lib/db/schema";

import type { Bounds } from "../types";
import { BOOKING_SOURCES, type ChannelPerformanceRow } from "./types";

type Db = NodePgDatabase<typeof schema>;

export async function getChannelPerformanceReport(
  db: Db,
  venueId: string,
  bounds: Bounds,
): Promise<ChannelPerformanceRow[]> {
  const leadDays = sql`(${bookings.startAt} AT TIME ZONE ${bounds.timezone})::date - (${bookings.createdAt} AT TIME ZONE ${bounds.timezone})::date`;

  const main = await db
    .select({
      source: bookings.source,
      total: sql<number>`count(*)::int`.as("total"),
      eligible:
        sql<number>`count(*) filter (where ${bookings.status} in ('confirmed','seated','finished','no_show'))::int`.as(
          "eligible",
        ),
      noShows: sql<number>`count(*) filter (where ${bookings.status} = 'no_show')::int`.as(
        "noShows",
      ),
      cancelled: sql<number>`count(*) filter (where ${bookings.status} = 'cancelled')::int`.as(
        "cancelled",
      ),
      coversSum: sql<number>`coalesce(sum(${bookings.partySize}), 0)::int`.as("coversSum"),
      leadSum:
        sql<number>`coalesce(sum(${leadDays}) filter (where ${bookings.status} <> 'cancelled'), 0)::int`.as(
          "leadSum",
        ),
      leadCount: sql<number>`count(*) filter (where ${bookings.status} <> 'cancelled')::int`.as(
        "leadCount",
      ),
    })
    .from(bookings)
    .where(
      and(
        eq(bookings.venueId, venueId),
        gte(bookings.startAt, bounds.startUtc),
        lt(bookings.startAt, bounds.endUtc),
      ),
    )
    .groupBy(bookings.source);

  const deposits = await db
    .select({
      source: bookings.source,
      depositBound:
        sql<number>`count(distinct ${bookings.id}) filter (where ${payments.kind} in ('deposit','hold'))::int`.as(
          "depositBound",
        ),
      captured:
        sql<number>`count(distinct ${bookings.id}) filter (where ${payments.kind} = 'no_show_capture')::int`.as(
          "captured",
        ),
    })
    .from(bookings)
    .innerJoin(payments, eq(payments.bookingId, bookings.id))
    .where(
      and(
        eq(bookings.venueId, venueId),
        gte(bookings.startAt, bounds.startUtc),
        lt(bookings.startAt, bounds.endUtc),
        eq(payments.status, "succeeded"),
      ),
    )
    .groupBy(bookings.source);

  const mainBySource = new Map(main.map((r) => [r.source, r]));
  const depBySource = new Map(deposits.map((r) => [r.source, r]));

  return BOOKING_SOURCES.map((source) => {
    const m = mainBySource.get(source);
    const d = depBySource.get(source);
    const total = m?.total ?? 0;
    const eligible = m?.eligible ?? 0;
    const leadCount = m?.leadCount ?? 0;
    const depositBound = d?.depositBound ?? 0;
    return {
      source,
      bookings: total,
      noShowRate: eligible === 0 ? 0 : (m?.noShows ?? 0) / eligible,
      cancellationRate: total === 0 ? 0 : (m?.cancelled ?? 0) / total,
      avgPartySize: total === 0 ? 0 : (m?.coversSum ?? 0) / total,
      avgLeadTimeDays: leadCount === 0 ? 0 : (m?.leadSum ?? 0) / leadCount,
      depositCaptureRate: depositBound === 0 ? null : (d?.captured ?? 0) / depositBound,
    };
  });
}
