// GET /api/v1/services — list services for the auth'd organisation.
//
// Optional filter: `?venue_id=<uuid>`. No pagination (cap 200).

import { NextResponse } from "next/server";

import { withApiAuth } from "@/lib/api/v1/auth-wrapper";
import { errorResponse } from "@/lib/api/v1/responses";
import { listServices } from "@/lib/api/v1/venues-services";
import { adminDb } from "@/lib/server/admin/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const GET = withApiAuth(async ({ req, orgId }) => {
  const url = new URL(req.url);
  const venueId = url.searchParams.get("venue_id");
  if (venueId && !UUID_RE.test(venueId)) {
    return errorResponse("bad_request", "venue_id must be a UUID.");
  }
  const result = await listServices(adminDb(), {
    organisationId: orgId,
    ...(venueId ? { venueId } : {}),
  });
  return NextResponse.json(result);
});
