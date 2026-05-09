// GET /api/v1/venues — list venues for the auth'd organisation.
//
// Unbounded but capped at 200 in the helper. No pagination today;
// typical orgs have <50 venues. If a customer ever blows past, add
// cursor pagination — same shape as bookings/guests.

import { NextResponse } from "next/server";

import { withApiAuth } from "@/lib/api/v1/auth-wrapper";
import { listVenues } from "@/lib/api/v1/venues-services";
import { adminDb } from "@/lib/server/admin/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = withApiAuth(async ({ orgId }) => {
  const result = await listVenues(adminDb(), { organisationId: orgId });
  return NextResponse.json(result);
});
