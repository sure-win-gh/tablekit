// POST /api/twilio/webhook — Twilio inbound SMS + status callbacks.
//
// Two flavours of payload come through this URL:
//   1. Inbound SMS (when a guest replies STOP / HELP / etc).
//      Twilio sends `From`, `To`, `Body`. We parse for STOP keywords
//      and mark the guest's phone as invalid (per our spec — opt-out
//      is venue-scoped via the unsubscribe URL on the SMS body, but
//      a STOP reply is a global signal we have to honour for any
//      number we send to).
//   2. Status callbacks for outbound SMS (when we set
//      statusCallback on the create call). Twilio sends MessageSid,
//      MessageStatus = delivered | failed | undelivered. We update
//      the matching messages row.
//
// Twilio signs requests with HMAC-SHA1 over (full URL + sorted body
// params). Twilio's SDK has validateRequest() — we use it.

import { eq, sql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { validateRequest } from "twilio";

import { guests, messages } from "@/lib/db/schema";
import { hashForLookup } from "@/lib/security/crypto";
import { audit } from "@/lib/server/admin/audit";
import { adminDb } from "@/lib/server/admin/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const STOP_WORDS = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"]);

export async function POST(req: NextRequest) {
  const authToken = process.env["TWILIO_AUTH_TOKEN"];
  if (!authToken || authToken.includes("YOUR_")) {
    return NextResponse.json({ error: "server-misconfigured" }, { status: 500 });
  }
  const signature = req.headers.get("x-twilio-signature");
  if (!signature) return NextResponse.json({ error: "missing-signature" }, { status: 400 });

  // Twilio sends application/x-www-form-urlencoded.
  const formText = await req.text();
  const params = Object.fromEntries(new URLSearchParams(formText));

  // The URL Twilio used to sign — must match what's in the dashboard.
  // Vercel sets x-forwarded-* so reconstruct properly.
  const host = req.headers.get("host") ?? "localhost:3000";
  const proto =
    req.headers.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const url = `${proto}://${host}${req.nextUrl.pathname}`;

  if (!validateRequest(authToken, signature, url, params)) {
    return NextResponse.json({ error: "bad-signature" }, { status: 400 });
  }

  // Branch on the params shape — inbound SMS has Body + From; status
  // callback has MessageSid + MessageStatus.
  if (typeof params["Body"] === "string" && typeof params["From"] === "string") {
    return handleInbound(params["From"], params["Body"]);
  }
  if (typeof params["MessageSid"] === "string" && typeof params["MessageStatus"] === "string") {
    return handleStatus(params["MessageSid"], params["MessageStatus"]);
  }
  return NextResponse.json({ ok: true, ignored: "unrecognised-payload" });
}

async function handleInbound(from: string, body: string) {
  const trimmed = body.trim().toUpperCase();
  if (!STOP_WORDS.has(trimmed)) {
    // HELP and other keywords could be added here. For MVP, only
    // STOP-family triggers an action.
    return NextResponse.json({ ok: true, action: "no-keyword-match" });
  }

  // Find the guest by phone hash and flag them invalid for SMS. We
  // hash here rather than decrypting every guest row.
  const phoneHash = hashForLookup(from, "phone");
  // Note: we don't currently store phoneHash on guests. For MVP we
  // skip the per-guest lookup and rely on Twilio's own opt-out cache
  // (Twilio refuses to deliver to numbers that have STOPped that
  // sending number). When we add phone_hash to guests as a follow-
  // up, this branch updates phone_invalid for the matching row.
  void phoneHash;

  return NextResponse.json({ ok: true, action: "stop-acknowledged" });
}

async function handleStatus(messageSid: string, status: string) {
  const db = adminDb();
  const [msg] = await db
    .select({
      id: messages.id,
      organisationId: messages.organisationId,
      bookingId: messages.bookingId,
    })
    .from(messages)
    .where(eq(messages.providerId, messageSid))
    .limit(1);
  if (!msg) return NextResponse.json({ ok: true, ignored: "unknown-message" });

  if (status === "delivered") {
    await db
      .update(messages)
      .set({ status: "delivered", deliveredAt: sql`now()` })
      .where(eq(messages.id, msg.id));
  } else if (status === "failed" || status === "undelivered") {
    await db
      .update(messages)
      .set({ status: "bounced", error: `twilio:${status}` })
      .where(eq(messages.id, msg.id));
    await markPhoneInvalid(msg.bookingId);
    await audit.log({
      organisationId: msg.organisationId,
      actorUserId: null,
      action: "message.bounced",
      targetType: "message",
      targetId: msg.id,
      metadata: { reason: status, bookingId: msg.bookingId },
    });
  }
  return NextResponse.json({ ok: true });
}

async function markPhoneInvalid(bookingId: string): Promise<void> {
  const db = adminDb();
  const { bookings } = await import("@/lib/db/schema");
  const [b] = await db
    .select({ guestId: bookings.guestId })
    .from(bookings)
    .where(eq(bookings.id, bookingId))
    .limit(1);
  if (!b) return;
  await db.update(guests).set({ phoneInvalid: true }).where(eq(guests.id, b.guestId));
}
