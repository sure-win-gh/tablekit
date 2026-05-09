// GET /api/v1/guests — list guests for the auth'd organisation.
//
// Cursor pagination via `?cursor=<opaque>&limit=N` (default 20, max
// 100). Order: created_at desc, id desc. List response is the
// minimal projection (no last_name/email/phone decryption); fetch
// /v1/guests/:id for full PII.

import { NextResponse } from "next/server";

import { withApiAuth } from "@/lib/api/v1/auth-wrapper";
import { decodeCursor, parseLimit } from "@/lib/api/v1/cursor";
import { listGuests } from "@/lib/api/v1/guests";
import { adminDb } from "@/lib/server/admin/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = withApiAuth(async ({ req, orgId }) => {
  const url = new URL(req.url);
  const result = await listGuests(adminDb(), {
    organisationId: orgId,
    cursor: decodeCursor<string>(url.searchParams.get("cursor")),
    limit: parseLimit(url.searchParams.get("limit")),
  });
  return NextResponse.json(result);
});
