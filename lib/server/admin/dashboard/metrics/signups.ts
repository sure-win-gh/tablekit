// Signups (organisation creations) over time.
//
// Aggregates organisations.created_at across all orgs — this is the
// reason for adminDb() (cross-org by design). Operator-side queries
// would be RLS-scoped and only ever return their own org's row.

import "server-only";

import { count, gte, lte, and } from "drizzle-orm";

import { organisations } from "@/lib/db/schema";

import { lastNDays, todayUtc } from "../filter";
import type { AdminDb } from "../types";

export type SignupCounts = {
  today: number;
  last7d: number;
  last30d: number;
};

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
