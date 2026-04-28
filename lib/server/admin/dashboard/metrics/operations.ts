// Platform-wide operational health for /admin/operations.
//
// Four independent queries fanned out via Promise.all — each is a
// straight aggregate over an indexed column. None decrypt PII.

import "server-only";

import { and, count, desc, eq, gte, inArray, max, sql } from "drizzle-orm";

import {
  dsarRequests,
  messages,
  organisations,
  payments,
  stripeEvents,
} from "@/lib/db/schema";

import { lastNDays } from "../filter";
import type { AdminDb } from "../types";

export type MessageHealth7dRow = {
  channel: string;
  delivered: number;
  failed: number;
  bounced: number;
  total: number;
};

export type PaymentFailureRow = {
  orgId: string;
  orgName: string;
  count: number;
  lastFailureAt: Date | null;
};

export type WebhookHealth = {
  totalLast24h: number;
  unhandledTotal: number;
  lastReceivedAt: Date | null;
};

export type DsarSummary = {
  open: number;
  overdue: number;
  dueWithin7d: number;
};

export type OperationsSnapshot = {
  messages: MessageHealth7dRow[];
  paymentFailures7d: PaymentFailureRow[];
  webhooks: WebhookHealth;
  dsars: DsarSummary;
};

const FAILED_PAYMENT_STATUSES = ["failed", "requires_payment_method"];
const OPEN_DSAR_STATUSES = ["pending", "in_progress"];

export async function getOperationsSnapshot(db: AdminDb): Promise<OperationsSnapshot> {
  const sevenDays = lastNDays(7);
  const oneDay = lastNDays(1);
  const now = new Date();
  const dueSoonCutoff = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  const [msgRows, payFailures, webhookCount24h, webhookUnhandled, webhookLast, dsarRows] =
    await Promise.all([
      db
        .select({
          channel: messages.channel,
          status: messages.status,
          n: count(),
        })
        .from(messages)
        .where(gte(messages.createdAt, sevenDays.fromUtc))
        .groupBy(messages.channel, messages.status),
      db
        .select({
          orgId: payments.organisationId,
          orgName: organisations.name,
          count: count(),
          lastFailureAt: max(payments.createdAt),
        })
        .from(payments)
        .innerJoin(organisations, eq(organisations.id, payments.organisationId))
        .where(
          and(
            inArray(payments.status, FAILED_PAYMENT_STATUSES),
            gte(payments.createdAt, sevenDays.fromUtc),
          ),
        )
        .groupBy(payments.organisationId, organisations.name)
        .orderBy(desc(count())),
      db.select({ n: count() }).from(stripeEvents).where(gte(stripeEvents.receivedAt, oneDay.fromUtc)),
      db
        .select({ n: count() })
        .from(stripeEvents)
        .where(sql`${stripeEvents.handledAt} is null`),
      db.select({ at: max(stripeEvents.receivedAt) }).from(stripeEvents),
      db
        .select({
          status: dsarRequests.status,
          dueAt: dsarRequests.dueAt,
        })
        .from(dsarRequests)
        .where(inArray(dsarRequests.status, OPEN_DSAR_STATUSES)),
    ]);

  // Pivot the (channel, status) cells into a per-channel row with
  // delivered/failed/bounced totals.
  const byChannel = new Map<string, MessageHealth7dRow>();
  for (const row of msgRows) {
    const r =
      byChannel.get(row.channel) ??
      ({ channel: row.channel, delivered: 0, failed: 0, bounced: 0, total: 0 } as MessageHealth7dRow);
    r.total += row.n;
    if (row.status === "delivered") r.delivered += row.n;
    else if (row.status === "failed") r.failed += row.n;
    else if (row.status === "bounced") r.bounced += row.n;
    byChannel.set(row.channel, r);
  }

  const dsars: DsarSummary = { open: dsarRows.length, overdue: 0, dueWithin7d: 0 };
  for (const row of dsarRows) {
    if (row.dueAt < now) dsars.overdue += 1;
    else if (row.dueAt < dueSoonCutoff) dsars.dueWithin7d += 1;
  }

  return {
    messages: Array.from(byChannel.values()).sort((a, b) => b.total - a.total),
    paymentFailures7d: payFailures.slice(0, 50),
    webhooks: {
      totalLast24h: webhookCount24h[0]?.n ?? 0,
      unhandledTotal: webhookUnhandled[0]?.n ?? 0,
      lastReceivedAt: webhookLast[0]?.at ?? null,
    },
    dsars,
  };
}
