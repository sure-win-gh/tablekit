// Spend report — POS revenue for the range, bucketed by venue-local day
// the order was closed. Only meaningful when a POS connection is live;
// with no rows the card renders an empty state, not zeros dressed as
// insight.
//
// avg-per-cover is computed only over orders whose till reported a
// cover count — mixing in unknown-cover orders would silently deflate
// the number.

import "server-only";

import { and, asc, eq, gte, lt, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { posOrders } from "@/lib/db/schema";
import type * as schema from "@/lib/db/schema";

import type { Bounds, SpendReport } from "./types";

type Db = NodePgDatabase<typeof schema>;

export async function getSpendReport(
  db: Db,
  venueId: string,
  bounds: Bounds,
): Promise<SpendReport> {
  const inRange = and(
    eq(posOrders.venueId, venueId),
    gte(posOrders.closedAt, bounds.startUtc),
    lt(posOrders.closedAt, bounds.endUtc),
  );

  const byDayRaw = await db
    .select({
      day: sql<string>`(${posOrders.closedAt} AT TIME ZONE ${bounds.timezone})::date::text`.as(
        "day",
      ),
      orders: sql<number>`count(*)::int`.as("orders"),
      revenueMinor: sql<number>`coalesce(sum(${posOrders.totalMinor}), 0)::bigint`.as(
        "revenueMinor",
      ),
      covers: sql<number>`coalesce(sum(${posOrders.coverCount}), 0)::int`.as("covers"),
      coveredRevenueMinor:
        sql<number>`coalesce(sum(${posOrders.totalMinor}) filter (where ${posOrders.coverCount} is not null), 0)::bigint`.as(
          "coveredRevenueMinor",
        ),
    })
    .from(posOrders)
    .where(inRange)
    .groupBy(sql`1`)
    .orderBy(asc(sql`1`));

  // bigint sums arrive as strings from pg — normalise before math.
  const byDay = byDayRaw.map((r) => ({
    day: r.day,
    orders: r.orders,
    revenueMinor: Number(r.revenueMinor),
    covers: r.covers,
    coveredRevenueMinor: Number(r.coveredRevenueMinor),
  }));

  const orders = byDay.reduce((sum, r) => sum + r.orders, 0);
  const revenueMinor = byDay.reduce((sum, r) => sum + r.revenueMinor, 0);
  const covers = byDay.reduce((sum, r) => sum + r.covers, 0);
  const coveredRevenueMinor = byDay.reduce((sum, r) => sum + r.coveredRevenueMinor, 0);

  return {
    orders,
    revenueMinor,
    covers,
    avgPerOrderMinor: orders === 0 ? 0 : Math.round(revenueMinor / orders),
    avgPerCoverMinor: covers === 0 ? null : Math.round(coveredRevenueMinor / covers),
    byDay: byDay.map(({ day, orders: o, revenueMinor: rev }) => ({
      day,
      orders: o,
      revenueMinor: rev,
    })),
  };
}
