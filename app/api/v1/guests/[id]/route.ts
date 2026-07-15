// GET /api/v1/guests/:id — full guest detail (decrypted PII).
//
// Bearer auth via withApiAuth; org scope from the API key. 404
// for unknown id OR cross-org id (uniform shape, no leak).

import { NextResponse } from "next/server";

import { withApiAuth } from "@/lib/api/v1/auth-wrapper";
import { getGuest } from "@/lib/api/v1/guests";
import { errorResponse } from "@/lib/api/v1/responses";
import { UUID_RE } from "@/lib/api/v1/validation";
import { adminDb } from "@/lib/server/admin/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = withApiAuth(async ({ req, orgId }) => {
  const url = new URL(req.url);
  const id = url.pathname.split("/").filter(Boolean).pop();
  if (!id || !UUID_RE.test(id)) {
    return errorResponse("bad_request", "Guest id must be a UUID.");
  }
  const guest = await getGuest(adminDb(), { organisationId: orgId, id });
  if (!guest) return errorResponse("not_found", "Guest not found.");
  return NextResponse.json({ data: guest });
});
