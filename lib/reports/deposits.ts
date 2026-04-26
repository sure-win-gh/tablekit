// Deposit revenue + refunds, bucketed by venue-local day of the
// booking's start_at. We bucket by booking start (not payment created)
// so an operator's "April revenue" is the deposits collected for April
// service, regardless of when the guest paid (could've been weeks
// earlier). This is how operators think about it.
//
// `noShowCapturedMinor` is the off-session capture (flow B) — a
// separate revenue line because operators want to track "money we
// caught from would-be no-shows" distinctly from "money we collected
// at booking".
//
// Refunds are stored as positive integers in the `refund` payment kind
// (the `amount_minor` schema CHECK enforces sign). Net revenue subtracts
// them.

import "server-only";

import { and, asc, eq, gte, lt, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { bookings, payments } from "@/lib/db/schema";
import type * as schema from "@/lib/db/schema";

import type { Bounds, DepositRevenueRow } from "./types";

type Db = NodePgDatabase<typeof schema>;

export async function getDepositRevenueReport(
  db: Db,
  venueId: string,
  bounds: Bounds,
): Promise<DepositRevenueRow[]> {
  const rows = await db
    .select({
      day: sql<string>`(${bookings.startAt} AT TIME ZONE ${bounds.timezone})::date::text`.as("day"),
      depositsCollectedMinor:
        sql<number>`coalesce(sum(${payments.amountMinor}) filter (where ${payments.kind} = 'deposit' and ${payments.status} = 'succeeded'), 0)::int`.as(
          "depositsCollectedMinor",
        ),
      noShowCapturedMinor:
        sql<number>`coalesce(sum(${payments.amountMinor}) filter (where ${payments.kind} = 'no_show_capture' and ${payments.status} = 'succeeded'), 0)::int`.as(
          "noShowCapturedMinor",
        ),
      refundedMinor:
        sql<number>`coalesce(sum(${payments.amountMinor}) filter (where ${payments.kind} = 'refund' and ${payments.status} = 'succeeded'), 0)::int`.as(
          "refundedMinor",
        ),
    })
    .from(bookings)
    .innerJoin(payments, eq(payments.bookingId, bookings.id))
    .where(
      and(
        eq(bookings.venueId, venueId),
        gte(bookings.startAt, bounds.startUtc),
        lt(bookings.startAt, bounds.endUtc),
      ),
    )
    .groupBy(sql`1`)
    .orderBy(asc(sql`1`));

  return rows.map((r) => ({
    day: r.day,
    depositsCollectedMinor: r.depositsCollectedMinor,
    noShowCapturedMinor: r.noShowCapturedMinor,
    refundedMinor: r.refundedMinor,
    netMinor: r.depositsCollectedMinor + r.noShowCapturedMinor - r.refundedMinor,
  }));
}
