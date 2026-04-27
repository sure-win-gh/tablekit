// Bookings volume + source mix across the platform.
//
// Counts by bookings.created_at (the moment the booking was placed)
// rather than start_at — for the founder's view "how many bookings did
// the platform produce" is more meaningful than "how many seatings
// happen today". Source mix is whatever values appear in
// bookings.source today (host / widget / walk-in / future rwg / api).

import "server-only";

import { and, count, desc, gte, lte, sql } from "drizzle-orm";

import { bookings } from "@/lib/db/schema";

import { lastNDays, todayUtc } from "../filter";
import type { AdminDb } from "../types";

export type BookingCounts = {
  today: number;
  last7d: number;
  last30d: number;
  sourceMix7d: { source: string; count: number }[];
};

export async function getBookingCounts(
  db: AdminDb,
  now: Date = new Date(),
): Promise<BookingCounts> {
  const [todayBounds, weekBounds, monthBounds] = [
    todayUtc(now),
    lastNDays(7, now),
    lastNDays(30, now),
  ];

  const totalAt = async (from: Date, to: Date) => {
    const [row] = await db
      .select({ n: count() })
      .from(bookings)
      .where(and(gte(bookings.createdAt, from), lte(bookings.createdAt, to)));
    return row?.n ?? 0;
  };

  const [today, last7d, last30d, sourceMix7d] = await Promise.all([
    totalAt(todayBounds.fromUtc, todayBounds.toUtc),
    totalAt(weekBounds.fromUtc, weekBounds.toUtc),
    totalAt(monthBounds.fromUtc, monthBounds.toUtc),
    db
      .select({
        source: bookings.source,
        count: sql<number>`count(*)::int`.as("count"),
      })
      .from(bookings)
      .where(
        and(gte(bookings.createdAt, weekBounds.fromUtc), lte(bookings.createdAt, weekBounds.toUtc)),
      )
      .groupBy(bookings.source)
      .orderBy(desc(sql`count(*)`)),
  ]);

  return { today, last7d, last30d, sourceMix7d };
}
