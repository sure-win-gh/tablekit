// Public booking API.
//
// POST /api/v1/bookings — anonymous, captcha + IP rate-limit. Used by
//   the embeddable widget. Same handler as the host dashboard's
//   create flow, just with `source: "widget"`.
//
// GET  /api/v1/bookings — Plus-tier REST list endpoint. Bearer auth
//   via API key (lib/api-keys/auth.ts). Org scope is resolved from
//   the key — never trust a query param. Filters: venue_id, from,
//   to, status. Cursor pagination. Lives in this PR (PR2 of public-api).
//
// The two handlers share a URL but are otherwise independent — one
// uses captcha + IP rate-limit, the other uses Bearer auth + (in
// PR3) per-key rate-limit.

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { withApiAuth } from "@/lib/api/v1/auth-wrapper";
import { BOOKING_STATUSES, type BookingStatusLiteral, listBookings } from "@/lib/api/v1/bookings";
import { decodeCursor, parseLimit } from "@/lib/api/v1/cursor";
import { errorResponse } from "@/lib/api/v1/responses";
import { createBooking } from "@/lib/bookings/create";
import { bookingsReadOnly, widgetDisabled } from "@/lib/feature-flags";
import { upsertGuestInput } from "@/lib/guests/schema";
import { sweepAbandonedDeposits } from "@/lib/payments/janitor";
import { bookingReference, verifyCaptcha } from "@/lib/public/captcha";
import { ipFromHeaders, rateLimit } from "@/lib/public/rate-limit";
import { resolveVenueOrg } from "@/lib/public/venue";
import { adminDb } from "@/lib/server/admin/db";

const Body = z.object({
  venueId: z.string().uuid(),
  serviceId: z.string().uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  wallStart: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/),
  partySize: z.number().int().min(1).max(20),
  notes: z.string().max(500).optional(),
  captchaToken: z.string().optional(),
  guest: upsertGuestInput,
});

export async function POST(req: NextRequest) {
  // 0. Kill switches. Cheaper than the rate-limit fetch + we want
  //    the same 503 shape across both flags so monitoring can match
  //    on { error: "widget-disabled" | "bookings-read-only" }.
  if (widgetDisabled()) {
    return NextResponse.json({ error: "widget-disabled" }, { status: 503 });
  }
  if (bookingsReadOnly()) {
    return NextResponse.json({ error: "bookings-read-only" }, { status: 503 });
  }

  // 1. Rate limit by IP before we do any DB work.
  const ip = ipFromHeaders(req.headers);
  const rl = await rateLimit(`bookings:${ip}`, 5, 10 * 60);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate-limited" },
      { status: 429, headers: { "retry-after": String(rl.retryAfterSec ?? 600) } },
    );
  }

  // 2. Parse + validate.
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

  // 3. Captcha. Pass-through if no secret configured.
  const captcha = await verifyCaptcha(parsed.data.captchaToken, ip);
  if (!captcha.ok) {
    return NextResponse.json({ error: "captcha-failed", reason: captcha.reason }, { status: 400 });
  }

  // 4. Resolve the org the venue belongs to. 404 if the venue is
  //    unknown — don't leak organisation structure by returning 403.
  const organisationId = await resolveVenueOrg(parsed.data.venueId);
  if (!organisationId) {
    return NextResponse.json({ error: "venue-not-found" }, { status: 404 });
  }

  // 4b. Best-effort sweep of abandoned deposits for this venue. This
  //     keeps the table-slot exclusion constraint honest in near-real-
  //     time on Hobby tier (Vercel Cron is once-daily there). If the
  //     sweep throws we don't block the booking — the daily cron is the
  //     backstop.
  try {
    await sweepAbandonedDeposits({ venueId: parsed.data.venueId });
  } catch (err) {
    console.error("[app/api/v1/bookings] inline janitor sweep failed:", {
      venueId: parsed.data.venueId,
      message: err instanceof Error ? err.message : String(err),
    });
  }

  // 5. Hand off to the same domain function the host flow uses.
  const r = await createBooking(organisationId, null, {
    venueId: parsed.data.venueId,
    serviceId: parsed.data.serviceId,
    date: parsed.data.date,
    wallStart: parsed.data.wallStart,
    partySize: parsed.data.partySize,
    guest: parsed.data.guest,
    source: "widget",
    ...(parsed.data.notes ? { notes: parsed.data.notes } : {}),
  });

  if (!r.ok) {
    const status = {
      "guest-invalid": 400,
      "slot-taken": 409,
      "no-availability": 409,
      "venue-not-found": 404,
      "deposit-failed": 502,
    }[r.reason];
    return NextResponse.json(
      { error: r.reason, ...("issues" in r ? { issues: r.issues } : {}) },
      { status },
    );
  }

  // Success response: always includes bookingId + reference + status.
  // If a deposit rule matched, the caller also gets `deposit` —
  // the widget mounts Stripe Elements with the client_secret and
  // confirms; the payment_intent.succeeded webhook transitions the
  // booking to `confirmed`.
  return NextResponse.json(
    {
      ok: true,
      bookingId: r.bookingId,
      reference: bookingReference(r.bookingId),
      status: r.status,
      ...(r.deposit ? { deposit: r.deposit } : {}),
    },
    { status: 201 },
  );
}

// ---------------------------------------------------------------------------
// GET — list bookings (Plus-tier REST API)
// ---------------------------------------------------------------------------

export const GET = withApiAuth(async ({ req, orgId }) => {
  const url = new URL(req.url);
  const venueId = url.searchParams.get("venue_id") ?? undefined;
  const fromRaw = url.searchParams.get("from");
  const toRaw = url.searchParams.get("to");
  const statusRaw = url.searchParams.get("status");

  const from = fromRaw ? parseDate(fromRaw) : null;
  if (fromRaw && !from) return errorResponse("bad_request", "Invalid `from` timestamp.");
  const to = toRaw ? parseDate(toRaw) : null;
  if (toRaw && !to) return errorResponse("bad_request", "Invalid `to` timestamp.");

  let status: BookingStatusLiteral[] | undefined;
  if (statusRaw) {
    const requested = statusRaw.split(",").map((s) => s.trim());
    const invalid = requested.filter((s) => !BOOKING_STATUSES.includes(s as BookingStatusLiteral));
    if (invalid.length > 0) {
      return errorResponse("bad_request", `Unknown status value: ${invalid.join(", ")}.`);
    }
    status = requested as BookingStatusLiteral[];
  }

  const result = await listBookings(adminDb(), {
    organisationId: orgId,
    venueId,
    from: from ?? undefined,
    to: to ?? undefined,
    status,
    cursor: decodeCursor<string>(url.searchParams.get("cursor")),
    limit: parseLimit(url.searchParams.get("limit")),
  });

  return NextResponse.json(result);
});

function parseDate(raw: string): Date | null {
  const d = new Date(raw);
  return Number.isFinite(d.getTime()) ? d : null;
}
