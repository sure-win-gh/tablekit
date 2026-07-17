// Fan a campaign out into campaign_sends rows, one per eligible guest.
//
// Idempotent on (campaign_id, guest_id, channel) — re-running never
// double-enqueues. Sets the campaign's first-attempt time (now for
// send-now, scheduled_at for scheduled) and flips its status. The
// dispatch worker drains the rows.

import "server-only";

import { eq, sql } from "drizzle-orm";

import { toPlan } from "@/lib/auth/plan-level";
import { estimateCostPence } from "@/lib/billing/usage";
import { InsufficientCreditError, reserveForCampaign } from "@/lib/billing/credit";
import { getEmailAllowanceState, isEmailOverageEnforced } from "@/lib/billing/email-allowance";
import { MARKETING_EMAIL, emailCampaignCostPence } from "@/lib/billing/marketing-email";
import { campaigns, campaignSends, organisations } from "@/lib/db/schema";
import { isSegment } from "@/lib/guests/segments";
import { audit } from "@/lib/server/admin/audit";
import { adminDb } from "@/lib/server/admin/db";

import type { MessageChannel } from "@/lib/messaging/registry";
import { resolveRecipientIds } from "./recipients";

export type EnqueueCampaignResult =
  | { ok: true; queued: number }
  | { ok: false; reason: "not-found" | "already-sent" }
  | { ok: false; reason: "insufficient-credit"; balancePence: number; requiredPence: number };

export async function enqueueCampaign(
  campaignId: string,
  opts: { scheduleAt?: Date; now: Date },
): Promise<EnqueueCampaignResult> {
  const db = adminDb();
  const [campaign] = await db
    .select({
      id: campaigns.id,
      organisationId: campaigns.organisationId,
      venueId: campaigns.venueId,
      channel: campaigns.channel,
      status: campaigns.status,
      segment: campaigns.segment,
    })
    .from(campaigns)
    .where(eq(campaigns.id, campaignId))
    .limit(1);
  if (!campaign) return { ok: false, reason: "not-found" };
  if (campaign.status === "sent" || campaign.status === "sending") {
    return { ok: false, reason: "already-sent" };
  }

  const channel = campaign.channel as MessageChannel;
  const guestIds = await resolveRecipientIds(campaign.organisationId, campaign.venueId, channel, {
    segment: isSegment(campaign.segment) ? campaign.segment : "all",
    now: opts.now,
  });

  // Prepaid gate: reserve the estimated cost up front before any send is
  // queued, so marketing can never exceed paid-for credit. SMS/WhatsApp
  // are costed per message; email is costed on the overage beyond the
  // plan's monthly allowance (docs/specs/email-broadcast-billing.md) —
  // and stays free while EMAIL_OVERAGE_ENFORCED is off (display-only
  // rollout). Reservation is keyed on the campaign id, so a retried
  // enqueue doesn't double-charge; reconcileCampaign refunds the unsent
  // remainder once the campaign drains.
  //
  // Narrow leak window: the reserve commits in its own tx before the
  // fan-out below. If the process dies between them the campaign stays
  // 'draft' (never drains → reconcile never runs) and the reservation
  // sits debited. The campaign-id-keyed reserve means re-sending that same
  // campaign reuses it (no double charge); an abandoned draft's reserve is
  // recovered by a manual 'adjustment' ledger entry. Acceptable for v1.
  let estimatePence: number;
  if (channel === "email") {
    if (isEmailOverageEnforced()) {
      const [org] = await db
        .select({ plan: organisations.plan })
        .from(organisations)
        .where(eq(organisations.id, campaign.organisationId))
        .limit(1);
      const plan = toPlan(org?.plan ?? "free");
      const state = await getEmailAllowanceState(campaign.organisationId, plan, opts.now);
      const rate = MARKETING_EMAIL.overagePencePer1000[plan];
      estimatePence = emailCampaignCostPence(guestIds.length, state.remaining, rate);
      // Snapshot the allowance + rate BEFORE reserving, so reconcile costs
      // the actual sends against the exact same base (the costing
      // invariant in lib/billing/marketing-email.ts). Written even for a
      // zero estimate — a re-enqueue overwrites with fresh values, which
      // is fine while the campaign has never reserved.
      await db
        .update(campaigns)
        .set({
          allowanceRemainingAtReserve: state.remaining,
          overagePencePer1000AtReserve: rate,
        })
        .where(eq(campaigns.id, campaign.id));
    } else {
      estimatePence = 0;
    }
  } else {
    estimatePence = estimateCostPence(channel, guestIds.length);
  }
  try {
    await reserveForCampaign(campaign.organisationId, campaign.id, estimatePence);
  } catch (err) {
    if (err instanceof InsufficientCreditError) {
      return {
        ok: false,
        reason: "insufficient-credit",
        balancePence: err.balancePence,
        requiredPence: err.requiredPence,
      };
    }
    throw err;
  }

  const firstAttempt = opts.scheduleAt ?? opts.now;
  if (guestIds.length > 0) {
    await db
      .insert(campaignSends)
      .values(
        guestIds.map((guestId) => ({
          organisationId: campaign.organisationId, // overwritten by enforce trigger
          campaignId: campaign.id,
          guestId,
          venueId: campaign.venueId,
          channel,
          nextAttemptAt: firstAttempt,
        })),
      )
      .onConflictDoNothing({
        target: [campaignSends.campaignId, campaignSends.guestId, campaignSends.channel],
      });
  }

  await db
    .update(campaigns)
    .set({
      status: opts.scheduleAt ? "scheduled" : "sending",
      ...(opts.scheduleAt ? { scheduledAt: opts.scheduleAt } : {}),
      counts: sql`jsonb_set(coalesce(${campaigns.counts}, '{}'::jsonb), '{queued}', to_jsonb(${guestIds.length}::int))`,
    })
    .where(eq(campaigns.id, campaign.id));

  await audit.log({
    organisationId: campaign.organisationId,
    actorUserId: null,
    action: "campaign.enqueued",
    targetType: "campaign",
    targetId: campaign.id,
    metadata: { channel, queued: guestIds.length, scheduled: Boolean(opts.scheduleAt) },
  });

  return { ok: true, queued: guestIds.length };
}
