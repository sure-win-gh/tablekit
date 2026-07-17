// Public booking API.
//
// POST /api/v1/bookings — two flows behind one URL:
//   • With `Authorization: Bearer sk_live_…` header → authed Plus-tier
//     REST. Body shape is the widget's minus `captchaToken`. Goes
//     through withApiAuth (per-key rate limit + redacted error
//     mapping). Optional `Idempotency-Key` header dedups retries.
//     Source: "api".
//   • Without auth header → existing anonymous widget flow. IP rate
//     limit + captcha + venue→org resolution. Source: "widget".
//
// GET  /api/v1/bookings — Plus-tier REST list endpoint. Bearer auth.
//   Filters: venue_id, from, to, status. Cursor pagination.

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { withApiAuth } from "@/lib/api/v1/auth-wrapper";
import { BOOKING_STATUSES, type BookingStatusLiteral, listBookings } from "@/lib/api/v1/bookings";
import { decodeCursor, parseLimit } from "@/lib/api/v1/cursor";
import { withIdempotency } from "@/lib/api/v1/idempotency";
import { errorResponse } from "@/lib/api/v1/responses";
import { createBooking } from "@/lib/bookings/create";
import { bookingsReadOnly, widgetDisabled } from "@/lib/feature-flags";
import { upsertGuestInput } from "@/lib/guests/schema";
import { sweepAbandonedDeposits } from "@/lib/payments/janitor";
import { bookingReference, verifyCaptcha } from "@/lib/public/captcha";
import { ipFromHeaders, rateLimit } from "@/lib/public/rate-limit";
import { resolveVenueOrg } from "@/lib/public/venue";
import { hashForLookup } from "@/lib/security/crypto";
import { adminDb } from "@/lib/server/admin/db";

const Body = z.object({
  venueId: z.string().uuid(),
  serviceId: z.string().uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  wallStart: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/),
  partySize: z.number().int().min(1).max(20),
  notes: z.string().max(500).optional(),
  // Guest area preference — a guarantee: the booking is assigned in this
  // area or fails no-availability (docs/specs/area-preferences.md).
  preferredAreaId: z.string().uuid().optional(),
  captchaToken: z.string().optional(),
  guest: upsertGuestInput,
});

export async function POST(req: NextRequest): Promise<Response> {
  // Branch first — authed REST request goes through a completely
  // separate pipeline (no captcha, per-key rate limit, idempotency).
  if (req.headers.get("authorization")) {
    return authedPost(req);
  }

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

  // 2b. Per-email rate limit (spec acceptance #8). The IP bucket
  //     above blunts a single attacker hammering one venue; this
  //     bucket blunts a distributed bot net all submitting under the
  //     same guest email (e.g. card-testing or harassment of one
  //     real address). Hashed via hashForLookup so the bucket key
  //     is non-PII even on Upstash. 3 successful posts per hour per
  //     email is generous for a real human re-trying a flaky
  //     network — anything more is automation.
  const emailHash = hashForLookup(parsed.data.guest.email, "email");
  const emailRl = await rateLimit(`bookings:email:${emailHash}`, 3, 60 * 60);
  if (!emailRl.ok) {
    return NextResponse.json(
      { error: "rate-limited" },
      { status: 429, headers: { "retry-after": String(emailRl.retryAfterSec ?? 3600) } },
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
    ...(parsed.data.preferredAreaId ? { preferredAreaId: parsed.data.preferredAreaId } : {}),
  });

  if (!r.ok) {
    const status = {
      "guest-invalid": 400,
      "slot-taken": 409,
      "no-availability": 409,
      "venue-closed": 409,
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

// ---------------------------------------------------------------------------
// POST — authed REST create (Plus-tier)
// ---------------------------------------------------------------------------

// Same shape as the widget body minus captchaToken. The auth wrapper
// already established orgId from the API key — venueId is checked
// against that org by the existing booking domain (createBooking →
// resolveVenueOrg internally returns the venue's true org and the
// engine rejects mismatches).
//
// Guest schema is the widget's MINUS `marketingConsentAt`. An API
// integrator must not be able to forge marketing consent on behalf
// of a guest who never opted in (GDPR Art 7 — controller must
// demonstrate consent). Operators set consent via the dashboard's
// guest profile, not via this endpoint. (The widget collects consent
// from the guest themselves at booking time, which is the lawful
// pathway for the same flag.)
const AuthedGuestInput = upsertGuestInput.omit({ marketingConsentAt: true });
const AuthedBody = z.object({
  venueId: z.string().uuid(),
  serviceId: z.string().uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  wallStart: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/),
  partySize: z.number().int().min(1).max(20),
  notes: z.string().max(500).optional(),
  guest: AuthedGuestInput,
});

// Body size cap. JSON parse buffers everything before validation
// runs, so an attacker can force a multi-MB parse without ever
// hitting Zod. 32KB is generous (a fully-padded valid request is
// well under 1KB) and applies symmetrically to retries.
const MAX_BODY_BYTES = 32 * 1024;

const authedPost = withApiAuth(async ({ req, orgId, keyId }) => {
  // Kill switches still apply — the API has no obligation to keep
  // taking writes during an incident.
  if (bookingsReadOnly()) {
    return errorResponse("bad_request", "Bookings are temporarily read-only.");
  }

  // Cheap size check before buffering. Content-Length isn't authoritative
  // (a hostile client can lie or omit it) but the platform also caps
  // the request — this guards the common honest case + catches
  // accidents.
  const contentLength = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return errorResponse("bad_request", "Request body too large.");
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse("bad_request", "Request body must be valid JSON.");
  }
  const parsed = AuthedBody.safeParse(body);
  if (!parsed.success) {
    return errorResponse(
      "bad_request",
      `Invalid input: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }

  // Cross-org check: venueId in the body must belong to the auth'd
  // org. Without this check, a key in org A could spray bookings
  // into org B's venues. createBooking trusts its `organisationId`
  // arg + uses it on every write, so the writes would carry org A's
  // FK against org B's venue — which the venue→service join would
  // reject, but only after we've already upserted a guest in org A.
  // Cheap pre-check is the right shape.
  const venueOrg = await resolveVenueOrg(parsed.data.venueId);
  if (venueOrg !== orgId) {
    return errorResponse("not_found", "Venue not found.");
  }

  // Optional Idempotency-Key. Per Stripe convention, header is
  // case-insensitive; Next normalises to lower-case.
  const idempotencyKey = req.headers.get("idempotency-key");

  const run = async () => {
    const r = await createBooking(orgId, null, {
      venueId: parsed.data.venueId,
      serviceId: parsed.data.serviceId,
      date: parsed.data.date,
      wallStart: parsed.data.wallStart,
      partySize: parsed.data.partySize,
      guest: parsed.data.guest,
      source: "api",
      ...(parsed.data.notes ? { notes: parsed.data.notes } : {}),
      ...(parsed.data.preferredAreaId ? { preferredAreaId: parsed.data.preferredAreaId } : {}),
    });

    if (!r.ok) {
      const status: Record<typeof r.reason, number> = {
        "guest-invalid": 400,
        "slot-taken": 409,
        "no-availability": 409,
        "venue-closed": 409,
        "venue-not-found": 404,
        "deposit-failed": 502,
      };
      return {
        status: status[r.reason] ?? 500,
        body: {
          error: {
            code: r.reason === "venue-not-found" ? "not_found" : "bad_request",
            message: r.reason,
          },
        },
      };
    }
    return {
      status: 201,
      body: {
        data: {
          id: r.bookingId,
          reference: bookingReference(r.bookingId),
          status: r.status,
        },
      },
    };
  };

  if (!idempotencyKey) {
    const out = await run();
    return NextResponse.json(out.body, { status: out.status });
  }
  if (idempotencyKey.length < 1 || idempotencyKey.length > 200) {
    return errorResponse("bad_request", "Idempotency-Key must be 1–200 chars.");
  }
  const outcome = await withIdempotency({ apiKeyId: keyId, key: idempotencyKey }, run);
  if (outcome.kind === "in_flight") {
    return errorResponse("conflict", "Original request still in flight — retry shortly.");
  }
  return NextResponse.json(outcome.response.body, { status: outcome.response.status });
});
