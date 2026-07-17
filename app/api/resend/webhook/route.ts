// POST /api/resend/webhook — Resend bounce / complaint / delivered events.
//
// Verifies Svix signature, then mutates state:
//   * email.bounced (hard) → guests.email_invalid = true
//   * email.complained     → guests.email_invalid = true (treat as opt-out)
//   * email.delivered      → messages.status = 'delivered', delivered_at = now
//   * email.bounced (soft) / others → log + ignore for now
//
// We look up the message by its provider id (re_*); from there we
// have booking_id → guest_id. Resend's payload includes the
// `email_id` (the same value as our messages.provider_id).

import { eq, sql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import {
  ResendWebhookSecretMissingError,
  ResendWebhookSignatureError,
  verifyResendWebhook,
} from "@/lib/email/webhook-verify";
import {
  bookings,
  campaignLinkClicks,
  campaignSends,
  campaigns,
  guests,
  messages,
} from "@/lib/db/schema";
import { audit } from "@/lib/server/admin/audit";
import { adminDb } from "@/lib/server/admin/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Clicked-link URLs are truncated to this length before insert — keeps
// them under Postgres's ~2704-byte btree-index limit so a pathological
// URL can't throw and wedge the webhook into an infinite Resend retry.
const MAX_TRACKED_URL_LEN = 2048;

type ResendEvent = {
  type: string;
  data?: {
    email_id?: string;
    bounce?: { type?: string };
    // email.clicked carries the clicked link (plus ip/user-agent we
    // deliberately never store). Resend nests it under `click.link`.
    click?: { link?: string };
  };
};

export async function POST(req: NextRequest) {
  const body = await req.text();
  try {
    verifyResendWebhook({
      body,
      svixId: req.headers.get("svix-id"),
      svixTimestamp: req.headers.get("svix-timestamp"),
      svixSignature: req.headers.get("svix-signature"),
    });
  } catch (err) {
    if (err instanceof ResendWebhookSecretMissingError) {
      return NextResponse.json({ error: "server-misconfigured" }, { status: 500 });
    }
    if (err instanceof ResendWebhookSignatureError) {
      return NextResponse.json({ error: "bad-signature" }, { status: 400 });
    }
    throw err;
  }

  let event: ResendEvent;
  try {
    event = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: "invalid-json" }, { status: 400 });
  }

  const providerId = event.data?.email_id;
  if (!providerId) return NextResponse.json({ ok: true, ignored: "no-email-id" });

  const db = adminDb();
  const [msg] = await db
    .select({
      id: messages.id,
      organisationId: messages.organisationId,
      bookingId: messages.bookingId,
    })
    .from(messages)
    .where(eq(messages.providerId, providerId))
    .limit(1);

  // Not a transactional message — try a campaign send (engagement +
  // delivery events for marketing broadcasts land here too).
  if (!msg) return handleCampaignEvent(event, providerId);

  switch (event.type) {
    case "email.delivered":
      await db
        .update(messages)
        .set({ status: "delivered", deliveredAt: sql`now()` })
        .where(eq(messages.id, msg.id));
      break;
    case "email.bounced": {
      const hard = event.data?.bounce?.type === "Permanent";
      await db
        .update(messages)
        .set({ status: "bounced", error: `bounce:${event.data?.bounce?.type ?? "unknown"}` })
        .where(eq(messages.id, msg.id));
      if (hard) await invalidateEmailFor(msg.bookingId, msg.organisationId);
      await audit.log({
        organisationId: msg.organisationId,
        actorUserId: null,
        action: "message.bounced",
        targetType: "message",
        targetId: msg.id,
        metadata: { bounceType: event.data?.bounce?.type ?? null, bookingId: msg.bookingId },
      });
      break;
    }
    case "email.complained":
      await db
        .update(messages)
        .set({ status: "bounced", error: "complaint" })
        .where(eq(messages.id, msg.id));
      await invalidateEmailFor(msg.bookingId, msg.organisationId);
      await audit.log({
        organisationId: msg.organisationId,
        actorUserId: null,
        action: "guest.contact_invalidated",
        targetType: "message",
        targetId: msg.id,
        metadata: { reason: "complaint", bookingId: msg.bookingId },
      });
      break;
    default:
      // Other events (sent, opened, clicked) — no-op for now.
      break;
  }

  return NextResponse.json({ ok: true });
}

async function invalidateEmailFor(bookingId: string, organisationId: string): Promise<void> {
  const db = adminDb();
  const [bk] = await db
    .select({ guestId: bookings.guestId })
    .from(bookings)
    .where(eq(bookings.id, bookingId))
    .limit(1);
  if (!bk) return;
  await db.update(guests).set({ emailInvalid: true }).where(eq(guests.id, bk.guestId));
  void organisationId; // already audited at the caller
}

// Campaign-send engagement + delivery events. Looked up by the send's
// provider id (cs_* keyed). Stamps opened_at / clicked_at / status and
// bumps the parent campaign's rolling counts tally.
//
// Resend redelivers webhook events with no event-id we dedupe on, so
// every state change is made conditional (only stamp/bump when the row
// actually transitions) — otherwise a redelivered open would over-count.
async function handleCampaignEvent(event: ResendEvent, providerId: string) {
  const db = adminDb();
  const [cs] = await db
    .select({
      id: campaignSends.id,
      campaignId: campaignSends.campaignId,
      organisationId: campaignSends.organisationId,
      guestId: campaignSends.guestId,
    })
    .from(campaignSends)
    .where(eq(campaignSends.providerId, providerId))
    .limit(1);
  if (!cs) return NextResponse.json({ ok: true, ignored: "unknown-message" });

  const bump = async (key: string) =>
    db
      .update(campaigns)
      .set({
        counts: sql`jsonb_set(coalesce(${campaigns.counts}, '{}'::jsonb), ${`{${key}}`}, to_jsonb(coalesce((${campaigns.counts}->>${key})::int, 0) + 1))`,
      })
      .where(eq(campaigns.id, cs.campaignId));

  switch (event.type) {
    case "email.delivered": {
      const r = await db
        .update(campaignSends)
        .set({ status: "delivered" })
        .where(sql`${campaignSends.id} = ${cs.id} and ${campaignSends.status} <> 'delivered'`)
        .returning({ id: campaignSends.id });
      if (r.length > 0) await bump("delivered");
      break;
    }
    case "email.opened": {
      // First open only — guard both the stamp AND the count so a
      // redelivered event doesn't over-count.
      const r = await db
        .update(campaignSends)
        .set({ openedAt: sql`now()` })
        .where(sql`${campaignSends.id} = ${cs.id} and ${campaignSends.openedAt} is null`)
        .returning({ id: campaignSends.id });
      if (r.length > 0) await bump("opened");
      break;
    }
    case "email.clicked": {
      const r = await db
        .update(campaignSends)
        .set({ clickedAt: sql`now()` })
        .where(sql`${campaignSends.id} = ${cs.id} and ${campaignSends.clickedAt} is null`)
        .returning({ id: campaignSends.id });
      // The `clicked` tally counts unique clickers (first click per send),
      // so it only bumps on the first-click transition above.
      if (r.length > 0) await bump("clicked");
      // Per-URL link tracking (marketing-suite Phase C) is independent of
      // the first-click guard: record every distinct link this send
      // clicked. The unique (send, url) index dedupes repeat clicks on the
      // same link, so the report counts unique clickers per URL. Only the
      // URL is stored — never the ip/user-agent Resend also sends.
      const link = event.data?.click?.link;
      if (link) {
        // Cap the URL before it hits the unique btree index: Postgres
        // rejects index entries past ~2704 bytes, and an unguarded throw
        // here would 500 the webhook and make Resend retry the event
        // forever. 2048 is the conventional URL ceiling; longer links are
        // truncated for tracking (report display only).
        await db
          .insert(campaignLinkClicks)
          .values({
            organisationId: cs.organisationId, // defence-in-depth; the enforce trigger overwrites it
            campaignId: cs.campaignId,
            campaignSendId: cs.id,
            url: link.slice(0, MAX_TRACKED_URL_LEN),
          })
          .onConflictDoNothing({
            target: [campaignLinkClicks.campaignSendId, campaignLinkClicks.url],
          });
      }
      break;
    }
    case "email.bounced":
    case "email.complained": {
      await db.update(campaignSends).set({ status: "bounced" }).where(eq(campaignSends.id, cs.id));
      // A spam complaint (or hard bounce) is an opt-out signal — suppress
      // the guest from ALL future marketing on this channel by flipping
      // email_invalid (the audience predicate keys off it). Without this
      // the same complainant would be re-targeted by the next broadcast
      // (PECR / Art. 21). Mirrors invalidateEmailFor on the txn path.
      const hard = event.type === "email.complained" || event.data?.bounce?.type === "Permanent";
      if (hard) {
        await db.update(guests).set({ emailInvalid: true }).where(eq(guests.id, cs.guestId));
        await audit.log({
          organisationId: cs.organisationId,
          actorUserId: null,
          action: "guest.contact_invalidated",
          targetType: "guest",
          targetId: cs.guestId,
          metadata: { reason: event.type === "email.complained" ? "complaint" : "hard-bounce" },
        });
      }
      break;
    }
    default:
      break;
  }
  return NextResponse.json({ ok: true });
}
