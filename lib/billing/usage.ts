// Per-channel send cost + the monthly usage ledger.
//
// First usage-metering surface in the codebase. We record a running
// (org, period, channel) tally + estimated pass-through cost at each
// successful send (transactional + campaign). Stripe usage reporting is
// a later phase — this just captures the numbers truthfully now so the
// pass-through bill can be reconciled. Counts are non-PII aggregates.

import "server-only";

import { sql } from "drizzle-orm";

import { messageUsage } from "@/lib/db/schema";
import { adminDb } from "@/lib/server/admin/db";

import type { MessageChannel } from "@/lib/messaging/registry";

// Illustrative pass-through unit costs (pence). Email is free on the
// platform; SMS/WhatsApp are billed at cost. Tune against the real
// Twilio rate card before go-live — kept here as the single source.
export const CHANNEL_COST_PENCE: Record<MessageChannel, number> = {
  email: 0,
  sms: 4,
  whatsapp: 3,
};

export function estimateCostPence(channel: MessageChannel, count: number): number {
  return CHANNEL_COST_PENCE[channel] * Math.max(0, count);
}

// Current UTC billing period as 'yyyy-mm'. `now` is injectable so the
// dispatch worker (which already threads a clock for tests) stays
// deterministic; Date is otherwise avoided per repo conventions.
export function billingPeriod(now: Date): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

// Increment the (org, period, channel) tally by one send. Idempotent at
// the row level via upsert; the per-send call is NOT idempotent (each
// successful send counts once — callers invoke it exactly once on the
// mark-sent path).
export async function recordUsage(
  organisationId: string,
  channel: MessageChannel,
  now: Date,
): Promise<void> {
  const period = billingPeriod(now);
  const cost = CHANNEL_COST_PENCE[channel];
  await adminDb()
    .insert(messageUsage)
    .values({ organisationId, period, channel, count: 1, estCostPence: cost })
    .onConflictDoUpdate({
      target: [messageUsage.organisationId, messageUsage.period, messageUsage.channel],
      set: {
        count: sql`${messageUsage.count} + 1`,
        estCostPence: sql`${messageUsage.estCostPence} + ${cost}`,
      },
    });
}
