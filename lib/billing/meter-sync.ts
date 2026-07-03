// Report transactional SMS/WhatsApp usage to a Stripe Billing Meter.
//
// Transactional sends (booking confirmations/reminders) are POSTPAID: we
// tally their pass-through cost in message_usage (lib/billing/usage.ts) and
// bill it monthly on the subscription invoice via a metered price tied to a
// Stripe Meter. Marketing is NOT here — it's prepaid via credit (PR-2).
//
// This sync reports the *delta* in pence since we last reported, advancing
// the message_usage.reported_pence high-water mark. The Meter is configured
// (dashboard, see deploy.md) with `sum` aggregation and a £0.01/unit price,
// so reporting `value` in pence bills at exact cost.
//
// Idempotency: the meter event `identifier` encodes the pre-advance
// watermark, so a retry before the watermark moves sends the same id (Stripe
// dedups within a 24h+ window). After a successful event we advance the
// watermark, so the next delta gets a fresh id. Send-then-advance means a
// crash between the two under-reports by one delta (we eat the cost) rather
// than over-charging the customer — the safe direction.
//
// Concurrency: two overlapping cron runs are safe by the SAME identifier
// (both compute the same pre-advance id → Stripe dedups), not by a DB lock —
// fine for a once-daily cron. Residual edge: if the watermark-advance write
// failed and STAYED failed for >24h, a later run would re-send the same id
// outside the dedup window → one double-count. Vanishingly unlikely (a local
// Postgres write), accepted for v1.
//
// Assumes message_usage.est_cost_pence is APPEND-ONLY (monotonic): recordUsage
// only ever increments it. A decrement would make delta negative → filtered
// out by the WHERE below → never reported. Don't add a code path that lowers it.

import "server-only";

import { and, eq, sql } from "drizzle-orm";

import { billingPeriod } from "@/lib/billing/usage";
import { messageUsage, organisations } from "@/lib/db/schema";
import { isBillingEntity, type BillingEntity } from "@/lib/regions/mapping";
import { adminDb } from "@/lib/server/admin/db";
import { stripe, stripeEnabled } from "@/lib/stripe/client";

export type MeterSyncResult = { reported: number; skipped: number; failed: number };

// Billing Meters are per-Stripe-account, so the event name is per entity:
// uk reads STRIPE_METER_USAGE_EVENT_NAME_UK falling back to the legacy
// STRIPE_METER_USAGE_EVENT_NAME; us reads _US only (no fallback — a US
// org's usage must never be reported into the UK meter).
function meterEventName(entity: BillingEntity): string | null {
  const candidates =
    entity === "uk"
      ? ["STRIPE_METER_USAGE_EVENT_NAME_UK", "STRIPE_METER_USAGE_EVENT_NAME"]
      : ["STRIPE_METER_USAGE_EVENT_NAME_US"];
  for (const name of candidates) {
    const v = process.env[name];
    if (v && !v.includes("YOUR_")) return v;
  }
  return null;
}

// Is this entity ready to receive meter events?
function entityMeterReady(entity: BillingEntity): boolean {
  return stripeEnabled(entity) && meterEventName(entity) !== null;
}

export async function reportUsageDeltas(now: Date): Promise<MeterSyncResult> {
  const result: MeterSyncResult = { reported: 0, skipped: 0, failed: 0 };

  // No-op cleanly until Stripe + a Meter are configured for at least one
  // entity, so the cron is safe to ship before go-live.
  if (!entityMeterReady("uk") && !entityMeterReady("us")) return result;

  const period = billingPeriod(now);
  const db = adminDb();

  // Current-period rows with un-reported cost, joined to the org's platform
  // customer (the meter bills that customer).
  const rows = await db
    .select({
      id: messageUsage.id,
      organisationId: messageUsage.organisationId,
      channel: messageUsage.channel,
      estCostPence: messageUsage.estCostPence,
      reportedPence: messageUsage.reportedPence,
      customerId: organisations.stripeCustomerId,
      billingEntity: organisations.billingEntity,
    })
    .from(messageUsage)
    .innerJoin(organisations, eq(organisations.id, messageUsage.organisationId))
    .where(
      and(
        eq(messageUsage.period, period),
        sql`${messageUsage.estCostPence} > ${messageUsage.reportedPence}`,
      ),
    );

  for (const row of rows) {
    const delta = row.estCostPence - row.reportedPence;
    if (delta <= 0) continue;
    // No platform customer yet (org never subscribed) → can't bill. Skip;
    // the watermark stays put so it's picked up once they have a customer.
    if (!row.customerId) {
      result.skipped += 1;
      continue;
    }

    // The org's usage bills on its entity's account/meter. Skip (watermark
    // stays put) if that entity's Stripe or meter isn't configured yet.
    const entity = isBillingEntity(row.billingEntity) ? row.billingEntity : "uk";
    const eventName = meterEventName(entity);
    if (!entityMeterReady(entity) || !eventName) {
      result.skipped += 1;
      continue;
    }

    try {
      await stripe(entity).billing.meterEvents.create({
        event_name: eventName,
        payload: { stripe_customer_id: row.customerId, value: String(delta) },
        identifier: `${row.organisationId}_${period}_${row.channel}_${row.reportedPence}`,
      });
      await db
        .update(messageUsage)
        .set({ reportedPence: row.estCostPence })
        .where(eq(messageUsage.id, row.id));
      result.reported += 1;
    } catch (err) {
      // Per-row isolation: one org's Stripe error can't block the rest.
      result.failed += 1;
      console.error("[lib/billing/meter-sync.ts] meter event failed", {
        organisationId: row.organisationId,
        channel: row.channel,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}
