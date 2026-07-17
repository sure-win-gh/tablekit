// Public event-ticket purchase.
//
// POST /api/v1/events/purchase — anonymous, like the widget booking flow:
// IP + per-email rate limit, captcha, then hands off to createEventBooking
// (which does the oversell-safe reservation + Stripe PaymentIntent). Returns
// a `deposit`-shaped payload so the widget's existing Stripe Elements step can
// drive confirmation. See docs/specs/special-events.md Phase 2.

import { NextResponse, type NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { specialEvents } from "@/lib/db/schema";
import { createEventBooking } from "@/lib/events/purchase";
import { bookingsReadOnly, widgetDisabled } from "@/lib/feature-flags";
import { upsertGuestInput } from "@/lib/guests/schema";
import { sweepAbandonedEventBookings } from "@/lib/payments/janitor";
import { verifyCaptcha } from "@/lib/public/captcha";
import { ipFromHeaders, rateLimit } from "@/lib/public/rate-limit";
import { hashForLookup } from "@/lib/security/crypto";
import { adminDb } from "@/lib/server/admin/db";

const Body = z.object({
  eventId: z.string().uuid(),
  items: z
    .array(
      z.object({
        ticketTypeId: z.string().uuid(),
        quantity: z.number().int().min(1).max(50),
      }),
    )
    .min(1)
    .max(10),
  captchaToken: z.string().optional(),
  // Anonymous callers must never stamp marketing consent — mirrors
  // the public bookings route.
  guest: upsertGuestInput.omit({ marketingConsentAt: true }),
});

export async function POST(req: NextRequest): Promise<Response> {
  if (widgetDisabled()) {
    return NextResponse.json({ error: "widget-disabled" }, { status: 503 });
  }
  if (bookingsReadOnly()) {
    return NextResponse.json({ error: "bookings-read-only" }, { status: 503 });
  }

  const ip = ipFromHeaders(req.headers);
  const rl = await rateLimit(`events:${ip}`, 5, 10 * 60);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate-limited" },
      { status: 429, headers: { "retry-after": String(rl.retryAfterSec ?? 600) } },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid-json" }, { status: 400 });
  }
  const parsed = Body.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "invalid-input",
        issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      },
      { status: 400 },
    );
  }

  const emailHash = hashForLookup(parsed.data.guest.email, "email");
  const emailRl = await rateLimit(`events:email:${emailHash}`, 5, 60 * 60);
  if (!emailRl.ok) {
    return NextResponse.json(
      { error: "rate-limited" },
      { status: 429, headers: { "retry-after": String(emailRl.retryAfterSec ?? 3600) } },
    );
  }

  const captcha = await verifyCaptcha(parsed.data.captchaToken, ip);
  if (!captcha.ok) {
    return NextResponse.json({ error: "captcha-failed", reason: captcha.reason }, { status: 400 });
  }

  // Best-effort: release any abandoned reservations for this event's venue so a
  // fresh buyer can claim capacity that was held but never paid. The daily cron
  // is the backstop.
  try {
    const [ev] = await adminDb()
      .select({ venueId: specialEvents.venueId })
      .from(specialEvents)
      .where(eq(specialEvents.id, parsed.data.eventId))
      .limit(1);
    if (ev) await sweepAbandonedEventBookings({ venueId: ev.venueId });
  } catch (err) {
    console.error("[app/api/v1/events/purchase] inline janitor sweep failed:", {
      eventId: parsed.data.eventId,
      message: err instanceof Error ? err.message : String(err),
    });
  }

  const r = await createEventBooking({
    eventId: parsed.data.eventId,
    items: parsed.data.items,
    guest: parsed.data.guest,
  });

  if (!r.ok) {
    const status: Record<typeof r.reason, number> = {
      "guest-invalid": 400,
      "event-not-found": 404,
      "event-not-on-sale": 409,
      "invalid-items": 400,
      "sold-out": 409,
      "payments-unavailable": 503,
    };
    return NextResponse.json(
      { error: r.reason, ...("issues" in r ? { issues: r.issues } : {}) },
      { status: status[r.reason] },
    );
  }

  return NextResponse.json(
    {
      ok: true,
      bookingId: r.bookingId,
      amountMinor: r.amountMinor,
      // `deposit`-shaped so the widget's existing Payment Element step works.
      deposit: {
        kind: "payment_intent",
        clientSecret: r.clientSecret,
        amountMinor: r.amountMinor,
        stripeAccount: r.stripeAccount,
      },
    },
    { status: 201 },
  );
}
