// No-show + cancellation evolution — daily rows the chart rolls up to
// week/month/year in the browser.
//
// Two passes mirror lib/reports/no-show.ts: one for the overall eligible
// cohort, one for the with-deposit subset (which needs a payments join and
// distinct-counting so a booking with both a deposit and a hold counts
// once). Merged by venue-local day. Days are bucketed with
// `start_at AT TIME ZONE <tz>` so a near-midnight booking lands on the
// operator's calendar day, matching the rest of the reporting module.

import "server-only";

import { and, asc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { bookings, payments } from "@/lib/db/schema";
import type * as schema from "@/lib/db/schema";

import type { Bounds } from "../types";
import type { NoShowTrendDailyRow } from "./types";

type Db = NodePgDatabase<typeof schema>;

const ELIGIBLE = ["confirmed", "seated", "finished", "no_show"] as const;

export async function getNoShowTrendReport(
  db: Db,
  venueId: string,
  bounds: Bounds,
): Promise<NoShowTrendDailyRow[]> {
  const dayExpr = sql<string>`(${bookings.startAt} AT TIME ZONE ${bounds.timezone})::date::text`;

  const overall = await db
    .select({
      day: dayExpr.as("day"),
      eligible: sql<number>`count(*)::int`.as("eligible"),
      noShows: sql<number>`count(*) filter (where ${bookings.status} = 'no_show')::int`.as(
        "noShows",
      ),
    })
    .from(bookings)
    .where(
      and(
        eq(bookings.venueId, venueId),
        gte(bookings.startAt, bounds.startUtc),
        lt(bookings.startAt, bounds.endUtc),
        inArray(bookings.status, [...ELIGIBLE]),
      ),
    )
    .groupBy(sql`1`)
    .orderBy(asc(sql`1`));

  const withDeposit = await db
    .select({
      day: dayExpr.as("day"),
      eligible: sql<number>`count(distinct ${bookings.id})::int`.as("eligible"),
      noShows:
        sql<number>`count(distinct ${bookings.id}) filter (where ${bookings.status} = 'no_show')::int`.as(
          "noShows",
        ),
    })
    .from(bookings)
    .innerJoin(payments, eq(payments.bookingId, bookings.id))
    .where(
      and(
        eq(bookings.venueId, venueId),
        gte(bookings.startAt, bounds.startUtc),
        lt(bookings.startAt, bounds.endUtc),
        inArray(bookings.status, [...ELIGIBLE]),
        sql`${payments.kind} in ('deposit','hold')`,
        eq(payments.status, "succeeded"),
      ),
    )
    .groupBy(sql`1`);

  const wdByDay = new Map(withDeposit.map((r) => [r.day, r]));
  // Overall is the source of truth for which days exist (every with-deposit
  // day is also an overall day, since the deposit cohort is a subset).
  return overall.map((r) => {
    const wd = wdByDay.get(r.day);
    return {
      day: r.day,
      eligible: r.eligible,
      noShows: r.noShows,
      withDepositEligible: wd?.eligible ?? 0,
      withDepositNoShows: wd?.noShows ?? 0,
    };
  });
}
