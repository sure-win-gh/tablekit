// Server-side assembly for the suggestion engine. Two historical
// sub-queries (weekday walk-in share; per-service count of bookings from
// prior-no-show guests) plus the already-fetched summary rows feed a
// ServiceContext per service, which the pure rules consume.
//
// Suggestions are computed at request time, never stored — they're a
// function of current state, so persisting them would only invite
// staleness.

import "server-only";

import { and, eq, gte, lt, ne, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { dayKeyInZone, venueLocalDayRange, zonedWallToUtc, type DayKey } from "@/lib/bookings/time";
import { bookings } from "@/lib/db/schema";
import type * as schema from "@/lib/db/schema";

import type { ServiceSummaryRow } from "../summary";
import { runSuggestions } from "./run";
import type { Suggestion } from "./types";

type Db = NodePgDatabase<typeof schema>;

const DOW: DayKey[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const WALK_IN_LOOKBACK_DAYS = 56; // ~8 weeks of the same weekday

export async function getServiceSuggestions(
  db: Db,
  venueId: string,
  date: string,
  timezone: string,
  rows: ServiceSummaryRow[],
): Promise<Map<string, Suggestion>> {
  const { startUtc: dayStart, endUtc: dayEnd } = venueLocalDayRange(date, timezone);
  const weekday = dayKeyInZone(zonedWallToUtc(date, "12:00", timezone), timezone);
  const targetDow = DOW.indexOf(weekday);
  const lookbackStart = new Date(dayStart.getTime() - WALK_IN_LOOKBACK_DAYS * 86_400_000);

  // Walk-in share for this weekday over the recent past (venue-level).
  const [shareRow] = await db
    .select({
      walkin:
        sql<number>`coalesce(sum(${bookings.partySize}) filter (where ${bookings.source} = 'walk-in'), 0)::int`.as(
          "walkin",
        ),
      total: sql<number>`coalesce(sum(${bookings.partySize}), 0)::int`.as("total"),
    })
    .from(bookings)
    .where(
      and(
        eq(bookings.venueId, venueId),
        gte(bookings.startAt, lookbackStart),
        lt(bookings.startAt, dayStart),
        ne(bookings.status, "cancelled"),
        sql`extract(dow from (${bookings.startAt} AT TIME ZONE ${timezone}))::int = ${targetDow}`,
      ),
    );
  const walkInWeekdayShare = shareRow && shareRow.total > 0 ? shareRow.walkin / shareRow.total : 0;

  // Per-service count of today's non-cancelled bookings whose guest has a
  // prior no-show.
  const proneRows = await db
    .select({
      serviceId: bookings.serviceId,
      count: sql<number>`count(*)::int`.as("count"),
    })
    .from(bookings)
    .where(
      and(
        eq(bookings.venueId, venueId),
        gte(bookings.startAt, dayStart),
        lt(bookings.startAt, dayEnd),
        ne(bookings.status, "cancelled"),
        sql`exists (
          select 1 from ${bookings} prior
          where prior.guest_id = ${bookings.guestId}
            and prior.status = 'no_show'
            and prior.start_at < ${dayStart}
        )`,
      ),
    )
    .groupBy(bookings.serviceId);
  const proneByService = new Map(proneRows.map((r) => [r.serviceId, r.count]));

  const now = new Date();
  const out = new Map<string, Suggestion>();
  for (const row of rows) {
    const suggestion = runSuggestions({
      serviceId: row.serviceId,
      utilisation: row.utilisation,
      startsAt: row.windowStart,
      now,
      windowMinutes: (row.windowEnd.getTime() - row.windowStart.getTime()) / 60_000,
      turnMinutes: row.turnMinutes,
      walkInWeekdayShare,
      noShowProneBookingCount: proneByService.get(row.serviceId) ?? 0,
    });
    if (suggestion) out.set(row.serviceId, suggestion);
  }
  return out;
}
