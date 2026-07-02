// Reviews report — rating trend and source/sentiment mix for the range.
// Bucketed by submitted_at in the venue's zone. All sources (internal +
// Google/TripAdvisor/Facebook) are pooled for the headline; the by-source
// rows let the operator see platform skew.

import "server-only";

import { and, asc, desc, eq, gte, lt, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { reviews } from "@/lib/db/schema";
import type * as schema from "@/lib/db/schema";

import type { Bounds, ReviewsReport } from "./types";

type Db = NodePgDatabase<typeof schema>;

export async function getReviewsReport(
  db: Db,
  venueId: string,
  bounds: Bounds,
): Promise<ReviewsReport> {
  const inRange = and(
    eq(reviews.venueId, venueId),
    gte(reviews.submittedAt, bounds.startUtc),
    lt(reviews.submittedAt, bounds.endUtc),
  );

  const byDay = await db
    .select({
      day: sql<string>`(${reviews.submittedAt} AT TIME ZONE ${bounds.timezone})::date::text`.as(
        "day",
      ),
      count: sql<number>`count(*)::int`.as("count"),
      avgRating: sql<number>`round(avg(${reviews.rating})::numeric, 2)::float`.as("avgRating"),
    })
    .from(reviews)
    .where(inRange)
    .groupBy(sql`1`)
    .orderBy(asc(sql`1`));

  const bySource = await db
    .select({
      source: sql<string>`${reviews.source}::text`.as("source"),
      count: sql<number>`count(*)::int`.as("count"),
      avgRating: sql<number>`round(avg(${reviews.rating})::numeric, 2)::float`.as("avgRating"),
    })
    .from(reviews)
    .where(inRange)
    .groupBy(reviews.source)
    .orderBy(desc(sql`count(*)`));

  const [totals] = await db
    .select({
      count: sql<number>`count(*)::int`.as("count"),
      // Overall average from the raw rows — not re-derived from the
      // rounded per-day averages, which would compound rounding error.
      avgRating: sql<number | null>`round(avg(${reviews.rating})::numeric, 2)::float`.as(
        "avgRating",
      ),
      positive: sql<number>`count(*) filter (where ${reviews.sentiment} = 'positive')::int`.as(
        "positive",
      ),
      neutral: sql<number>`count(*) filter (where ${reviews.sentiment} = 'neutral')::int`.as(
        "neutral",
      ),
      negative: sql<number>`count(*) filter (where ${reviews.sentiment} = 'negative')::int`.as(
        "negative",
      ),
      unclassified: sql<number>`count(*) filter (where ${reviews.sentiment} is null)::int`.as(
        "unclassified",
      ),
    })
    .from(reviews)
    .where(inRange);

  const count = totals?.count ?? 0;

  return {
    count,
    avgRating: count === 0 ? null : (totals?.avgRating ?? null),
    byDay,
    bySource,
    sentiment: {
      positive: totals?.positive ?? 0,
      neutral: totals?.neutral ?? 0,
      negative: totals?.negative ?? 0,
      unclassified: totals?.unclassified ?? 0,
    },
  };
}
