// Campaign dispatch worker — drains campaign_sends.
//
// Mirrors lib/messaging/dispatch.ts (atomic FOR UPDATE SKIP LOCKED
// claim, exponential backoff, audit) but guest-scoped. Reuses the
// shared provider send functions + backoff/truncate helpers. Two extra
// guarantees vs transactional: (1) it RE-CHECKS marketing consent +
// suppression + erasure per send (the state can change between enqueue
// and send), and (2) it records pass-through usage on each success.

import "server-only";

import { eq, sql } from "drizzle-orm";

import { campaigns, campaignSends, guests, venues } from "@/lib/db/schema";
import { EmailSendError, sendEmail } from "@/lib/email/send";
import { decryptPii, type Ciphertext } from "@/lib/security/crypto";
import { audit } from "@/lib/server/admin/audit";
import { adminDb } from "@/lib/server/admin/db";
import { SmsSendError, sendSms } from "@/lib/sms/send";
import { WhatsAppSendError, sendWhatsApp } from "@/lib/whatsapp/send";

import { backoffMs, truncateError } from "@/lib/messaging/enqueue";
import type { MessageChannel } from "@/lib/messaging/registry";
import { unsubscribeUrl } from "@/lib/messaging/tokens";
import { parseBranding } from "@/lib/messaging/venue-settings";

import { renderCampaign } from "./render";
import { isStillEligible } from "./recipients";
import { recordUsage } from "./usage";

export type CampaignDispatchResult = {
  processed: number;
  sent: number;
  failed: number;
  retried: number;
  skipped: number;
};

type ClaimedRow = {
  id: string;
  organisationId: string;
  campaignId: string;
  guestId: string;
  venueId: string;
  channel: string;
  attempts: number;
};

export async function processNextCampaignBatch(
  opts: { limit?: number; now?: Date; appUrl?: string } = {},
): Promise<CampaignDispatchResult> {
  const limit = opts.limit ?? 50;
  const now = opts.now ?? nowFromEnvSafe();
  const appUrl = opts.appUrl ?? process.env["NEXT_PUBLIC_APP_URL"] ?? "https://app.tablekit.test";
  const db = adminDb();

  const claimed = (await db.execute(sql`
    update campaign_sends
    set status = 'sending', attempts = attempts + 1, updated_at = now()
    where id in (
      select id from campaign_sends
      where (status = 'queued' and next_attempt_at <= now())
         or (status = 'sending' and updated_at < now() - interval '5 minutes')
      order by next_attempt_at
      limit ${limit}
      for update skip locked
    )
    returning id, organisation_id as "organisationId", campaign_id as "campaignId",
              guest_id as "guestId", venue_id as "venueId", channel, attempts
  `)) as unknown as { rows?: ClaimedRow[] } | ClaimedRow[];

  const rows: ClaimedRow[] = Array.isArray(claimed) ? claimed : (claimed.rows ?? []);
  if (rows.length === 0) return { processed: 0, sent: 0, failed: 0, retried: 0, skipped: 0 };

  let sent = 0;
  let failed = 0;
  let retried = 0;
  let skipped = 0;
  for (const row of rows) {
    const outcome = await processOne(row, appUrl, now);
    if (outcome === "sent") sent += 1;
    else if (outcome === "retried") retried += 1;
    else if (outcome === "skipped") skipped += 1;
    else failed += 1;
  }

  // Mark any campaigns whose queue is now fully drained as 'sent'.
  await finaliseDrainedCampaigns(rows.map((r) => r.campaignId));

  return { processed: rows.length, sent, failed, retried, skipped };
}

type Outcome = "sent" | "retried" | "failed" | "skipped";

async function processOne(row: ClaimedRow, appUrl: string, now: Date): Promise<Outcome> {
  const channel = row.channel as MessageChannel;
  const db = adminDb();

  // Re-check eligibility at send time — consent withdrawn / unsubscribed
  // / erased since enqueue must stop the send.
  if (!(await isStillEligible(row.organisationId, row.venueId, channel, row.guestId))) {
    return markSkipped(row, "ineligible-at-send");
  }

  const [ctx] = await db
    .select({
      guestFirstName: guests.firstName,
      guestEmailCipher: guests.emailCipher,
      guestPhoneCipher: guests.phoneCipher,
      venueName: venues.name,
      venueSettings: venues.settings,
      campaignSubject: campaigns.subjectOverride,
      campaignBody: campaigns.body,
    })
    .from(campaignSends)
    .innerJoin(campaigns, eq(campaigns.id, campaignSends.campaignId))
    .innerJoin(guests, eq(guests.id, campaignSends.guestId))
    .innerJoin(venues, eq(venues.id, campaignSends.venueId))
    .where(eq(campaignSends.id, row.id))
    .limit(1);
  if (!ctx) return markFailed(row, "context-missing");

  let recipient: string;
  try {
    recipient =
      channel === "email"
        ? await decryptPii(row.organisationId, ctx.guestEmailCipher as Ciphertext)
        : await decryptPii(row.organisationId, ctx.guestPhoneCipher as Ciphertext);
  } catch {
    return markFailed(row, "decrypt-failed");
  }

  const unsub = unsubscribeUrl(appUrl, {
    guestId: row.guestId,
    venueId: row.venueId,
    channel,
  });

  const rendered = await renderCampaign({
    channel,
    subject: ctx.campaignSubject,
    body: ctx.campaignBody,
    ctx: {
      guestFirstName: ctx.guestFirstName,
      venueName: ctx.venueName,
      unsubscribeUrl: unsub,
      branding: parseBranding(ctx.venueSettings),
    },
  });

  try {
    let providerId: string;
    if (rendered.kind === "email") {
      const branding = parseBranding(ctx.venueSettings);
      const r = await sendEmail({
        to: recipient,
        subject: rendered.rendered.subject,
        html: rendered.rendered.html,
        text: rendered.rendered.text,
        unsubscribeUrl: unsub,
        ...(branding?.replyTo ? { replyTo: branding.replyTo } : {}),
        idempotencyKey: `cs_${row.id}_v1`,
      });
      providerId = r.providerId;
    } else if (rendered.kind === "whatsapp") {
      const r = await sendWhatsApp({
        to: recipient,
        body: rendered.rendered.body,
        statusCallback: `${appUrl}/api/twilio/webhook`,
      });
      providerId = r.providerId;
    } else {
      const r = await sendSms({
        to: recipient,
        body: rendered.rendered.body,
        statusCallback: `${appUrl}/api/twilio/webhook`,
      });
      providerId = r.providerId;
    }
    return markSent(row, providerId, channel, now);
  } catch (err) {
    const retryable =
      (err instanceof EmailSendError ||
        err instanceof SmsSendError ||
        err instanceof WhatsAppSendError) &&
      err.retryable;
    return retryable ? scheduleRetry(row, err) : markFailed(row, truncateError(err));
  }
}

async function markSent(
  row: ClaimedRow,
  providerId: string,
  channel: MessageChannel,
  now: Date,
): Promise<"sent"> {
  const db = adminDb();
  await db
    .update(campaignSends)
    .set({ status: "sent", providerId, sentAt: sql`now()`, error: null })
    .where(eq(campaignSends.id, row.id));
  await bumpCount(row.campaignId, "sent");
  await recordUsage(row.organisationId, channel, now);
  return "sent";
}

async function markFailed(row: ClaimedRow, reason: string): Promise<"failed"> {
  const db = adminDb();
  await db
    .update(campaignSends)
    .set({ status: "failed", error: reason })
    .where(eq(campaignSends.id, row.id));
  await bumpCount(row.campaignId, "failed");
  await audit.log({
    organisationId: row.organisationId,
    actorUserId: null,
    action: "campaign.send_failed",
    targetType: "campaign",
    targetId: row.campaignId,
    metadata: { channel: row.channel, reason },
  });
  return "failed";
}

async function markSkipped(row: ClaimedRow, reason: string): Promise<"skipped"> {
  const db = adminDb();
  await db
    .update(campaignSends)
    .set({ status: "failed", error: reason })
    .where(eq(campaignSends.id, row.id));
  await bumpCount(row.campaignId, "skipped");
  // Audit the privacy-protective skip (consent withdrawn / unsubscribed /
  // erased between enqueue and send) for the Art. 5(2) accountability
  // trail. No guest PII in the payload.
  await audit.log({
    organisationId: row.organisationId,
    actorUserId: null,
    action: "campaign.send_failed",
    targetType: "campaign",
    targetId: row.campaignId,
    metadata: { channel: row.channel, reason, skipped: true },
  });
  return "skipped";
}

async function scheduleRetry(row: ClaimedRow, err: unknown): Promise<Outcome> {
  const delay = backoffMs(row.attempts);
  if (delay === null) return markFailed(row, `exhausted: ${truncateError(err)}`);
  const db = adminDb();
  await db
    .update(campaignSends)
    .set({
      status: "queued",
      nextAttemptAt: new Date(Date.now() + delay),
      error: truncateError(err),
    })
    .where(eq(campaignSends.id, row.id));
  return "retried";
}

// Increment a single key in the campaign's counts jsonb tally.
async function bumpCount(campaignId: string, key: string): Promise<void> {
  const db = adminDb();
  await db
    .update(campaigns)
    .set({
      counts: sql`jsonb_set(coalesce(${campaigns.counts}, '{}'::jsonb), ${`{${key}}`}, to_jsonb(coalesce((${campaigns.counts}->>${key})::int, 0) + 1))`,
    })
    .where(eq(campaigns.id, campaignId));
}

// Flip a campaign to 'sent' once it has no remaining queued/sending rows.
async function finaliseDrainedCampaigns(campaignIds: string[]): Promise<void> {
  const db = adminDb();
  const unique = [...new Set(campaignIds)];
  for (const id of unique) {
    const [pending] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(campaignSends)
      .where(
        sql`${campaignSends.campaignId} = ${id} and ${campaignSends.status} in ('queued','sending')`,
      );
    if ((pending?.n ?? 0) === 0) {
      await db
        .update(campaigns)
        .set({ status: "sent", sentAt: sql`now()` })
        .where(sql`${campaigns.id} = ${id} and ${campaigns.status} = 'sending'`);
    }
  }
}

// Date.now() is allowed in worker runtime (not in workflow scripts). We
// only avoid it where determinism matters; opts.now is the test seam.
function nowFromEnvSafe(): Date {
  return new Date();
}
