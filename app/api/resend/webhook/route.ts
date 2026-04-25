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
import { bookings, guests, messages } from "@/lib/db/schema";
import { audit } from "@/lib/server/admin/audit";
import { adminDb } from "@/lib/server/admin/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type ResendEvent = {
  type: string;
  data?: { email_id?: string; bounce?: { type?: string } };
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

  if (!msg) return NextResponse.json({ ok: true, ignored: "unknown-message" });

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
