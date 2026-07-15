// GET  /api/v1/bookings/:id — fetch one booking by id (Plus-tier REST).
// PATCH /api/v1/bookings/:id — cancel or reschedule (Plus-tier REST).
//
// Bearer auth via withApiAuth. Org scope is resolved from the API key
// and used as a WHERE filter — a key in org A asking for a booking
// in org B gets a 404 (uniform with "id doesn't exist", so cross-org
// existence is not leakable).
//
// PATCH supports two operations:
//   • Cancel   — body: { status: "cancelled", cancelled_reason?: string }
//   • Reschedule (time only) — body: { start_at: ISO timestamp }
// Combining both in a single PATCH is rejected with 400. Cross-table
// reassignment + party_size changes are out of scope for now (those
// have separate domain helpers and meaningful UX needs in the
// dashboard first).

import { NextResponse } from "next/server";
import { z } from "zod";

import { withApiAuth } from "@/lib/api/v1/auth-wrapper";
import { getBooking } from "@/lib/api/v1/bookings";
import { withIdempotency } from "@/lib/api/v1/idempotency";
import { errorResponse } from "@/lib/api/v1/responses";
import { UUID_RE } from "@/lib/api/v1/validation";
import { shiftBookingTime } from "@/lib/bookings/shift";
import { transitionBooking } from "@/lib/bookings/transition";
import { adminDb } from "@/lib/server/admin/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BODY_BYTES = 32 * 1024;

// -----------------------------------------------------------------------------
// GET — fetch one booking by id
// -----------------------------------------------------------------------------

export const GET = withApiAuth(async ({ req, orgId }) => {
  const id = idFromUrl(req.url);
  if (!id) return errorResponse("bad_request", "Booking id must be a UUID.");

  const booking = await getBooking(adminDb(), { organisationId: orgId, id });
  if (!booking) return errorResponse("not_found", "Booking not found.");
  return NextResponse.json({ data: booking });
});

// -----------------------------------------------------------------------------
// PATCH — cancel or reschedule
// -----------------------------------------------------------------------------

const PatchBody = z
  .object({
    status: z.literal("cancelled").optional(),
    cancelled_reason: z.string().trim().min(1).max(500).optional(),
    start_at: z.string().datetime({ offset: true }).optional(),
  })
  .refine(
    (b) => Boolean(b.status) !== Boolean(b.start_at),
    'Body must specify exactly one of `status: "cancelled"` or `start_at`.',
  )
  .refine(
    (b) => !(b.cancelled_reason && !b.status),
    '`cancelled_reason` is only valid with `status: "cancelled"`.',
  );

export const PATCH = withApiAuth(async ({ req, orgId, keyId }) => {
  const id = idFromUrl(req.url);
  if (!id) return errorResponse("bad_request", "Booking id must be a UUID.");

  const contentLength = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return errorResponse("bad_request", "Request body too large.");
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return errorResponse("bad_request", "Request body must be valid JSON.");
  }
  const parsed = PatchBody.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(
      "bad_request",
      `Invalid input: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }

  const idempotencyKey = req.headers.get("idempotency-key");
  if (idempotencyKey && (idempotencyKey.length < 1 || idempotencyKey.length > 200)) {
    return errorResponse("bad_request", "Idempotency-Key must be 1–200 chars.");
  }

  const run = async () => {
    if (parsed.data.status === "cancelled") {
      const r = await transitionBooking(orgId, null, id, "cancelled", {
        ...(parsed.data.cancelled_reason ? { cancelledReason: parsed.data.cancelled_reason } : {}),
      });
      if (!r.ok) {
        if (r.reason === "not-found") {
          return {
            status: 404,
            body: { error: { code: "not_found", message: "Booking not found." } },
          };
        }
        // invalid-transition → 409 conflict (e.g. tried to cancel a finished booking)
        return {
          status: 409,
          body: {
            error: {
              code: "conflict",
              message: `Cannot transition booking from ${r.from} to ${r.to}.`,
            },
          },
        };
      }
      return { status: 200, body: { data: { id, status: "cancelled" } } };
    }

    // start_at — reschedule
    const newStartAt = new Date(parsed.data.start_at!);
    const r = await shiftBookingTime({
      organisationId: orgId,
      actorUserId: null,
      bookingId: id,
      newStartAt,
    });
    if (!r.ok) {
      if (r.reason === "not-found") {
        return {
          status: 404,
          body: { error: { code: "not_found", message: "Booking not found." } },
        };
      }
      const messages: Record<"slot-taken" | "terminal-status", string> = {
        "slot-taken": "Slot taken — pick a different time.",
        "terminal-status": "Cannot reschedule a finished, cancelled, or no-show booking.",
      };
      return {
        status: 409,
        body: { error: { code: "conflict", message: messages[r.reason] } },
      };
    }
    return {
      status: 200,
      body: {
        data: {
          id,
          start_at: r.newStartAt.toISOString(),
          end_at: r.newEndAt.toISOString(),
        },
      },
    };
  };

  if (!idempotencyKey) {
    const out = await run();
    return NextResponse.json(out.body, { status: out.status });
  }
  const outcome = await withIdempotency({ apiKeyId: keyId, key: idempotencyKey }, run);
  if (outcome.kind === "in_flight") {
    return errorResponse("conflict", "Original request still in flight — retry shortly.");
  }
  return NextResponse.json(outcome.response.body, { status: outcome.response.status });
});

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

function idFromUrl(url: string): string | null {
  const u = new URL(url);
  const id = u.pathname.split("/").filter(Boolean).pop();
  return id && UUID_RE.test(id) ? id : null;
}
