// Public-API + operator-webhook health for /admin/operations.
//
// Two independent snapshots:
//
// - API: request volume / error rates / latency over the last 7 days
//   from api_request_log, plus a 14-day daily trend and the busiest
//   orgs. Latency percentiles via percentile_cont — fine at this
//   table's scale (90-day retention sweep keeps it bounded).
// - Operator webhooks: delivery success/failure over the last 7 days
//   from webhook_deliveries, plus the failing endpoints so a stuck
//   Zapier hook is visible before the operator emails in.
//
// No PII in either table (paths are stripped of query strings at
// write time; delivery payloads are ids + timestamps only).

import "server-only";

import { and, count, desc, eq, gte, isNull, sql } from "drizzle-orm";

import {
  apiRequestLog,
  organisations,
  webhookDeliveries,
  webhookSubscriptions,
} from "@/lib/db/schema";

import { lastNDays } from "../filter";
import type { AdminDb } from "../types";
import type { DailyBucket } from "./signups";

export type ApiHealth = {
  requests7d: number;
  serverErrors7d: number; // status >= 500
  clientErrors7d: number; // 400..499
  errorRate7d: number; // server errors / requests, 0 when no traffic
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  byDay: DailyBucket[]; // 14-day request trend
  topOrgs: { orgId: string; orgName: string; requests: number; serverErrors: number }[];
};

export type OperatorWebhookHealth = {
  activeSubscriptions: number;
  deliveries7d: number;
  failed7d: number;
  // All pending rows regardless of age — a stuck-pending delivery
  // older than the 7-day window must not vanish from this count.
  pendingNow: number;
  failingEndpoints: {
    subscriptionId: string;
    orgId: string;
    orgName: string;
    label: string;
    url: string;
    failed7d: number;
  }[];
};

export async function getApiHealth(db: AdminDb, now: Date = new Date()): Promise<ApiHealth> {
  const week = lastNDays(7, now);
  const fortnight = lastNDays(14, now);

  const [totals, latency, byDayRes, topOrgs] = await Promise.all([
    db
      .select({
        requests: count(),
        serverErrors: sql<number>`count(*) filter (where ${apiRequestLog.status} >= 500)::int`.as(
          "serverErrors",
        ),
        clientErrors:
          sql<number>`count(*) filter (where ${apiRequestLog.status} between 400 and 499)::int`.as(
            "clientErrors",
          ),
      })
      .from(apiRequestLog)
      .where(gte(apiRequestLog.createdAt, week.fromUtc)),
    db.execute<{ p50: number | null; p95: number | null }>(sql`
      select
        percentile_cont(0.5) within group (order by latency_ms) as p50,
        percentile_cont(0.95) within group (order by latency_ms) as p95
      from api_request_log
      where created_at >= ${week.fromUtc}
    `),
    db.execute<{ day: string; n: string | number }>(sql`
      SELECT to_char(d.day, 'YYYY-MM-DD') AS day, COALESCE(c.n, 0)::int AS n
      FROM generate_series(
        date_trunc('day', ${fortnight.fromUtc}::timestamptz at time zone 'UTC')::date,
        date_trunc('day', ${fortnight.toUtc}::timestamptz at time zone 'UTC')::date,
        '1 day'::interval
      ) AS d(day)
      LEFT JOIN (
        SELECT date_trunc('day', created_at at time zone 'UTC')::date AS bucket, count(*)::int AS n
        FROM api_request_log
        WHERE created_at >= ${fortnight.fromUtc} AND created_at <= ${fortnight.toUtc}
        GROUP BY 1
      ) c ON c.bucket = d.day
      ORDER BY d.day
    `),
    db
      .select({
        orgId: apiRequestLog.organisationId,
        orgName: organisations.name,
        requests: count(),
        serverErrors: sql<number>`count(*) filter (where ${apiRequestLog.status} >= 500)::int`.as(
          "serverErrors",
        ),
      })
      .from(apiRequestLog)
      .innerJoin(organisations, eq(organisations.id, apiRequestLog.organisationId))
      .where(gte(apiRequestLog.createdAt, week.fromUtc))
      .groupBy(apiRequestLog.organisationId, organisations.name)
      .orderBy(desc(count()))
      .limit(10),
  ]);

  const requests7d = totals[0]?.requests ?? 0;
  const serverErrors7d = totals[0]?.serverErrors ?? 0;
  const lat = latency.rows[0];

  return {
    requests7d,
    serverErrors7d,
    clientErrors7d: totals[0]?.clientErrors ?? 0,
    errorRate7d: requests7d === 0 ? 0 : serverErrors7d / requests7d,
    p50LatencyMs: lat?.p50 === null || lat?.p50 === undefined ? null : Math.round(Number(lat.p50)),
    p95LatencyMs: lat?.p95 === null || lat?.p95 === undefined ? null : Math.round(Number(lat.p95)),
    byDay: byDayRes.rows.map((r) => ({ day: r.day, n: Number(r.n) })),
    topOrgs,
  };
}

export async function getOperatorWebhookHealth(
  db: AdminDb,
  now: Date = new Date(),
): Promise<OperatorWebhookHealth> {
  const week = lastNDays(7, now);

  const [subs, totals, pendingAll, failing] = await Promise.all([
    db
      .select({ n: count() })
      .from(webhookSubscriptions)
      .where(and(eq(webhookSubscriptions.active, true), isNull(webhookSubscriptions.revokedAt))),
    db
      .select({
        total: count(),
        failed: sql<number>`count(*) filter (where ${webhookDeliveries.status} = 'failed')::int`.as(
          "failed",
        ),
      })
      .from(webhookDeliveries)
      .where(gte(webhookDeliveries.createdAt, week.fromUtc)),
    db
      .select({ n: count() })
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.status, "pending")),
    db
      .select({
        subscriptionId: webhookDeliveries.subscriptionId,
        orgId: webhookDeliveries.organisationId,
        orgName: organisations.name,
        label: webhookSubscriptions.label,
        url: webhookSubscriptions.url,
        failed7d: count(),
      })
      .from(webhookDeliveries)
      .innerJoin(
        webhookSubscriptions,
        eq(webhookSubscriptions.id, webhookDeliveries.subscriptionId),
      )
      .innerJoin(organisations, eq(organisations.id, webhookDeliveries.organisationId))
      .where(
        and(eq(webhookDeliveries.status, "failed"), gte(webhookDeliveries.createdAt, week.fromUtc)),
      )
      .groupBy(
        webhookDeliveries.subscriptionId,
        webhookDeliveries.organisationId,
        organisations.name,
        webhookSubscriptions.label,
        webhookSubscriptions.url,
      )
      .orderBy(desc(count()))
      .limit(10),
  ]);

  return {
    activeSubscriptions: subs[0]?.n ?? 0,
    deliveries7d: totals[0]?.total ?? 0,
    failed7d: totals[0]?.failed ?? 0,
    pendingNow: pendingAll[0]?.n ?? 0,
    failingEndpoints: failing,
  };
}
