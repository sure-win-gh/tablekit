// Signups (organisation creations) over time.
//
// Aggregates organisations.created_at across all orgs — this is the
// reason for adminDb() (cross-org by design). Operator-side queries
// would be RLS-scoped and only ever return their own org's row.

import "server-only";

import { count, gte, lte, and, sql } from "drizzle-orm";

import { organisations } from "@/lib/db/schema";

import { lastNDays, todayUtc } from "../filter";
import type { AdminDb } from "../types";

export type SignupCounts = {
  today: number;
  last7d: number;
  last30d: number;
};

export type DailyBucket = { day: string; n: number };

export async function getSignupCounts(db: AdminDb, now: Date = new Date()): Promise<SignupCounts> {
  const [todayBounds, weekBounds, monthBounds] = [todayUtc(now), lastNDays(7, now), lastNDays(30, now)];

  const at = async (from: Date, to: Date) => {
    const [row] = await db
      .select({ n: count() })
      .from(organisations)
      .where(and(gte(organisations.createdAt, from), lte(organisations.createdAt, to)));
    return row?.n ?? 0;
  };

  const [today, last7d, last30d] = await Promise.all([
    at(todayBounds.fromUtc, todayBounds.toUtc),
    at(weekBounds.fromUtc, weekBounds.toUtc),
    at(monthBounds.fromUtc, monthBounds.toUtc),
  ]);

  return { today, last7d, last30d };
}

// Daily buckets over the last `days` days, gap-filled with zeros so a
// quiet day still appears as a flat point on the sparkline. Single
// SQL via generate_series joined LEFT to the per-day count.
export async function getSignupsByDay(
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
      FROM organisations
      WHERE created_at >= ${bounds.fromUtc} AND created_at <= ${bounds.toUtc}
      GROUP BY 1
    ) c ON c.bucket = d.day
    ORDER BY d.day
  `);
  return result.rows.map((r) => ({ day: r.day, n: Number(r.n) }));
}
