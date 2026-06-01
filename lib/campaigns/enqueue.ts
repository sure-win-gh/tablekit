// Fan a campaign out into campaign_sends rows, one per eligible guest.
//
// Idempotent on (campaign_id, guest_id, channel) — re-running never
// double-enqueues. Sets the campaign's first-attempt time (now for
// send-now, scheduled_at for scheduled) and flips its status. The
// dispatch worker drains the rows.

import "server-only";

import { eq, sql } from "drizzle-orm";

import { campaigns, campaignSends } from "@/lib/db/schema";
import { audit } from "@/lib/server/admin/audit";
import { adminDb } from "@/lib/server/admin/db";

import type { MessageChannel } from "@/lib/messaging/registry";
import { resolveRecipientIds } from "./recipients";

export type EnqueueCampaignResult =
  | { ok: true; queued: number }
  | { ok: false; reason: "not-found" | "already-sent" };

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
    })
    .from(campaigns)
    .where(eq(campaigns.id, campaignId))
    .limit(1);
  if (!campaign) return { ok: false, reason: "not-found" };
  if (campaign.status === "sent" || campaign.status === "sending") {
    return { ok: false, reason: "already-sent" };
  }

  const channel = campaign.channel as MessageChannel;
  const guestIds = await resolveRecipientIds(campaign.organisationId, campaign.venueId, channel);

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
