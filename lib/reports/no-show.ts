// No-show rate report.
//
// Eligible denominator = bookings the operator showed up for: any of
// confirmed/seated/finished/no_show. Cancelled and still-requested are
// excluded — a cancellation isn't a no-show, and a stuck `requested`
// is the deposit-janitor's problem, not a kitchen-cover problem.
//
// "with-deposit" cuts the same cohort to bookings that had a succeeded
// deposit or hold payment — useful to answer "are deposits actually
// reducing no-shows?".

import "server-only";

import { and, asc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { bookings, payments, services } from "@/lib/db/schema";
import type * as schema from "@/lib/db/schema";

import type { Bounds, NoShowSummary } from "./types";

type Db = NodePgDatabase<typeof schema>;

const ELIGIBLE = ["confirmed", "seated", "finished", "no_show"] as const;

export async function getNoShowReport(
  db: Db,
  venueId: string,
  bounds: Bounds,
): Promise<NoShowSummary> {
  const eligibleArray = sql.raw(`array['confirmed','seated','finished','no_show']::text[]`);

  // One pass for overall + by-service. Two CTEs (overall, byService)
  // produce a single result set the JS side splits.
  const byServiceRows = await db
    .select({
      serviceId: bookings.serviceId,
      serviceName: services.name,
      eligible: sql<number>`count(*)::int`.as("eligible"),
      noShows:
        sql<number>`count(*) filter (where ${bookings.status} = 'no_show')::int`.as("noShows"),
    })
    .from(bookings)
    .innerJoin(services, eq(services.id, bookings.serviceId))
    .where(
      and(
        eq(bookings.venueId, venueId),
        gte(bookings.startAt, bounds.startUtc),
        lt(bookings.startAt, bounds.endUtc),
        inArray(bookings.status, [...ELIGIBLE]),
      ),
    )
    .groupBy(bookings.serviceId, services.name)
    .orderBy(asc(services.name));

  let totalEligible = 0;
  let totalNoShows = 0;
  for (const r of byServiceRows) {
    totalEligible += r.eligible;
    totalNoShows += r.noShows;
  }

  // With-deposit cohort: count bookings that have at least one
  // succeeded deposit or hold payment in the same range. Distinct on
  // booking_id so a booking with both a deposit and a hold counts once.
  const withDepositRows = await db
    .select({
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
        sql`${bookings.status} = ANY(${eligibleArray})`,
        sql`${payments.kind} in ('deposit','hold')`,
        eq(payments.status, "succeeded"),
      ),
    );

  const withDepositEligible = withDepositRows[0]?.eligible ?? 0;
  const withDepositNoShows = withDepositRows[0]?.noShows ?? 0;

  return {
    totalEligible,
    totalNoShows,
    rate: totalEligible === 0 ? 0 : totalNoShows / totalEligible,
    withDepositEligible,
    withDepositNoShows,
    withDepositRate: withDepositEligible === 0 ? 0 : withDepositNoShows / withDepositEligible,
    byService: byServiceRows.map((r) => ({
      serviceId: r.serviceId,
      serviceName: r.serviceName,
      eligible: r.eligible,
      noShows: r.noShows,
      rate: r.eligible === 0 ? 0 : r.noShows / r.eligible,
    })),
  };
}
