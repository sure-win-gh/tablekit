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
import type { DailyBucket } from "./signups";

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

// Daily booking creation buckets, gap-filled with zeros. See the
// matching helper in metrics/signups.ts — same SQL pattern.
export async function getBookingsByDay(
  db: AdminDb,
  days = 30,
  now: Date = new Date(),
): Promise<DailyBucket[]> {
  const bounds = lastNDays(days, now);
  const result = await db.execute<{ day: string; n: string | number }>(sql`
    SELECT to_char(d.day, 'YYYY-MM-DD') AS day, COALESCE(c.n, 0)::int AS n
    FROM generate_series(
      date_trunc('day', ${bounds.fromUtc}::timestamptz at time zone 'UTC')::date,
      date_trunc('day', ${bounds.toUtc}::timestamptz at time zone 'UTC')::date,
      '1 day'::interval
    ) AS d(day)
    LEFT JOIN (
      SELECT date_trunc('day', created_at at time zone 'UTC')::date AS bucket, count(*)::int AS n
      FROM bookings
      WHERE created_at >= ${bounds.fromUtc} AND created_at <= ${bounds.toUtc}
      GROUP BY 1
    ) c ON c.bucket = d.day
    ORDER BY d.day
  `);
  return result.rows.map((r) => ({ day: r.day, n: Number(r.n) }));
}
