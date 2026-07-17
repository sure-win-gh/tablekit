// Prepaid messaging credit — the ledger + the running balance.
//
// Marketing campaigns are PREPAID: an operator tops up a credit balance,
// and a campaign can only send if the balance covers its estimated cost.
// This removes the "blast thousands of texts then the card declines"
// exposure. Transactional sends are NOT gated by this (they're postpaid
// monthly via the usage meter) — only campaigns reserve/spend credit.
//
// Money model:
//   - organisations.credit_balance_pence is the live balance.
//   - billing_credit_ledger is the append-only audit trail; every entry
//     moves the balance and is written in the SAME transaction under a
//     row lock, so the balance can never drift from the ledger sum.
//   - (reason, ref) is unique → every top-up / reservation / refund
//     applies at most once (idempotent against webhook + worker retries).
//
// See docs/specs/stripe-billing.md.

import "server-only";

import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { estimateCostPence } from "@/lib/billing/usage";
import { emailCampaignCostPence } from "@/lib/billing/marketing-email";
import { billingCreditLedger, campaigns, campaignSends, organisations } from "@/lib/db/schema";
import type * as schema from "@/lib/db/schema";
import type { MessageChannel } from "@/lib/messaging/registry";
import { audit } from "@/lib/server/admin/audit";
import { adminDb } from "@/lib/server/admin/db";

type Db = NodePgDatabase<typeof schema>;

export type LedgerReason = "topup" | "campaign_reserve" | "campaign_refund" | "adjustment";

export class InsufficientCreditError extends Error {
  constructor(
    public readonly balancePence: number,
    public readonly requiredPence: number,
  ) {
    super(`InsufficientCreditError: balance ${balancePence}p < required ${requiredPence}p`);
    this.name = "InsufficientCreditError";
  }
}

// Current balance under the caller's db handle (withUser for the dashboard,
// adminDb for server paths).
export async function getBalance(db: Db, organisationId: string): Promise<number> {
  const [row] = await db
    .select({ bal: organisations.creditBalancePence })
    .from(organisations)
    .where(eq(organisations.id, organisationId))
    .limit(1);
  return row?.bal ?? 0;
}

// Apply a signed ledger entry + move the balance, atomically and
// idempotently. Locks the org row so concurrent applies serialise; the
// (reason, ref) unique index makes a duplicate a no-op. Returns whether it
// applied (false = duplicate) and the resulting balance. Used for top-ups
// (+) and refunds (+); reservations use reserveForCampaign (it must check
// before debiting). `adjustment` entries pass ref=null and are NOT
// idempotent (manual founder corrections).
export async function applyEntry(input: {
  organisationId: string;
  deltaPence: number;
  reason: LedgerReason;
  ref: string | null;
}): Promise<{ applied: boolean; balancePence: number }> {
  return adminDb().transaction(async (tx) => {
    const [org] = await tx
      .select({ bal: organisations.creditBalancePence })
      .from(organisations)
      .where(eq(organisations.id, input.organisationId))
      .for("update")
      .limit(1);
    if (!org) throw new Error(`applyEntry: org ${input.organisationId} not found`);

    const after = org.bal + input.deltaPence;
    const inserted = await tx
      .insert(billingCreditLedger)
      .values({
        organisationId: input.organisationId,
        deltaPence: input.deltaPence,
        reason: input.reason,
        ref: input.ref,
        balanceAfter: after,
      })
      .onConflictDoNothing({ target: [billingCreditLedger.reason, billingCreditLedger.ref] })
      .returning({ id: billingCreditLedger.id });

    if (inserted.length === 0) return { applied: false, balancePence: org.bal };

    await tx
      .update(organisations)
      .set({ creditBalancePence: after })
      .where(eq(organisations.id, input.organisationId));
    return { applied: true, balancePence: after };
  });
}

// Credit a successful top-up. Idempotent on the Stripe session id.
export async function recordTopup(
  organisationId: string,
  amountPence: number,
  stripeRef: string,
): Promise<void> {
  if (amountPence <= 0) return;
  const { applied, balancePence } = await applyEntry({
    organisationId,
    deltaPence: amountPence,
    reason: "topup",
    ref: stripeRef,
  });
  if (applied) {
    await audit.log({
      organisationId,
      actorUserId: null,
      action: "billing.credit.topup",
      targetType: "organisation",
      targetId: organisationId,
      metadata: { amountPence, balancePence, ref: stripeRef },
    });
  }
}

// Reserve a campaign's estimated cost up front. Race-safe: locks the org
// row, so two campaigns launching at once can't both spend past zero.
// Idempotent per campaign (one reserve row). Throws InsufficientCreditError
// when the balance can't cover the estimate. A zero estimate (e.g. an
// email-only campaign) is a no-op — those never consume credit.
export async function reserveForCampaign(
  organisationId: string,
  campaignId: string,
  estimatePence: number,
): Promise<void> {
  if (estimatePence <= 0) return;
  const reserved = await adminDb().transaction(async (tx) => {
    const [org] = await tx
      .select({ bal: organisations.creditBalancePence })
      .from(organisations)
      .where(eq(organisations.id, organisationId))
      .for("update")
      .limit(1);
    if (!org) throw new Error(`reserveForCampaign: org ${organisationId} not found`);

    // Already reserved for this campaign (a retried enqueue) → success, but
    // don't debit or audit again.
    const [existing] = await tx
      .select({ id: billingCreditLedger.id })
      .from(billingCreditLedger)
      .where(
        and(
          eq(billingCreditLedger.reason, "campaign_reserve"),
          eq(billingCreditLedger.ref, campaignId),
        ),
      )
      .limit(1);
    if (existing) return false;

    if (org.bal < estimatePence) throw new InsufficientCreditError(org.bal, estimatePence);

    const after = org.bal - estimatePence;
    await tx.insert(billingCreditLedger).values({
      organisationId,
      deltaPence: -estimatePence,
      reason: "campaign_reserve",
      ref: campaignId,
      balanceAfter: after,
    });
    await tx
      .update(organisations)
      .set({ creditBalancePence: after })
      .where(eq(organisations.id, organisationId));
    return true;
  });

  if (reserved) {
    await audit.log({
      organisationId,
      actorUserId: null,
      action: "billing.credit.reserved",
      targetType: "campaign",
      targetId: campaignId,
      metadata: { estimatePence },
    });
  }
}

// After a campaign finishes, refund the difference between what we reserved
// and what we actually sent (sends that were skipped/failed/became
// ineligible never cost us). Idempotent per campaign via the
// (campaign_refund, campaignId) ledger key, so it's safe to call from the
// dispatch finaliser on every drain. Self-contained: reads the reservation
// and the realised send count itself.
export async function reconcileCampaign(campaignId: string): Promise<void> {
  const db = adminDb();
  const [campaign] = await db
    .select({
      organisationId: campaigns.organisationId,
      channel: campaigns.channel,
      allowanceRemainingAtReserve: campaigns.allowanceRemainingAtReserve,
      overagePencePer1000AtReserve: campaigns.overagePencePer1000AtReserve,
    })
    .from(campaigns)
    .where(eq(campaigns.id, campaignId))
    .limit(1);
  if (!campaign) return;

  const [reserve] = await db
    .select({ delta: billingCreditLedger.deltaPence })
    .from(billingCreditLedger)
    .where(
      and(
        eq(billingCreditLedger.reason, "campaign_reserve"),
        eq(billingCreditLedger.ref, campaignId),
      ),
    )
    .limit(1);
  const reservedPence = reserve ? -reserve.delta : 0;
  if (reservedPence <= 0) return; // nothing was reserved (e.g. email campaign)

  // A send that succeeded has sent_at stamped; its status may since have
  // advanced to 'delivered' (or 'bounced') via provider webhooks. Those
  // sends still cost us, so count sent_at — counting status='sent' would
  // over-refund any campaign whose delivery events land before reconcile.
  const [{ n } = { n: 0 }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(campaignSends)
    .where(and(eq(campaignSends.campaignId, campaignId), isNotNull(campaignSends.sentAt)));

  // INVARIANT: reconcile MUST cost actuals with the same function AND the
  // same base the reserve used — estimateCostPence for SMS/WhatsApp;
  // emailCampaignCostPence against the allowance + rate SNAPSHOTS taken at
  // reserve time for email (a plan change mid-campaign must not reprice
  // it). If cost ever changes shape, reserve + reconcile change together.
  const actualPence =
    campaign.channel === "email"
      ? emailCampaignCostPence(
          n,
          campaign.allowanceRemainingAtReserve ?? 0,
          campaign.overagePencePer1000AtReserve ?? 0,
        )
      : estimateCostPence(campaign.channel as MessageChannel, n);
  const refund = Math.max(0, reservedPence - actualPence);
  if (refund === 0) return;

  const { applied, balancePence } = await applyEntry({
    organisationId: campaign.organisationId,
    deltaPence: refund,
    reason: "campaign_refund",
    ref: campaignId,
  });
  if (applied) {
    await audit.log({
      organisationId: campaign.organisationId,
      actorUserId: null,
      action: "billing.credit.refunded",
      targetType: "campaign",
      targetId: campaignId,
      metadata: { reservedPence, actualPence, refundPence: refund, balancePence },
    });
  }
}
