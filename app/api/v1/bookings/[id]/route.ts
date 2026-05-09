// GET /api/v1/bookings/:id — fetch one booking by id (Plus-tier REST).
//
// Bearer auth via withApiAuth. Org scope is resolved from the API key
// and used as a WHERE filter — a key in org A asking for a booking
// in org B gets a 404 (uniform with "id doesn't exist", so cross-org
// existence is not leakable).

import { NextResponse } from "next/server";

import { withApiAuth } from "@/lib/api/v1/auth-wrapper";
import { getBooking } from "@/lib/api/v1/bookings";
import { errorResponse } from "@/lib/api/v1/responses";
import { adminDb } from "@/lib/server/admin/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = withApiAuth(async ({ req, orgId }) => {
  // Pull `id` from the URL — Next.js 16 doesn't pass route params to
  // a wrapper-returned handler the same way it does to a top-level
  // export, so destructure from the path.
  const url = new URL(req.url);
  const id = url.pathname.split("/").filter(Boolean).pop();
  if (!id || !UUID_RE.test(id)) {
    return errorResponse("bad_request", "Booking id must be a UUID.");
  }

  const booking = await getBooking(adminDb(), { organisationId: orgId, id });
  if (!booking) return errorResponse("not_found", "Booking not found.");
  return NextResponse.json({ data: booking });
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
