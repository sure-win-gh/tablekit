// Square OAuth redirect target. Validates the signed state + CSRF cookie,
// exchanges the code for tokens, encrypts + upserts a pos_connections row
// (provider 'square', merchant id as external_account_id), then redirects
// the operator back to the venue POS settings page with a flash.

import { NextResponse, type NextRequest } from "next/server";

import { requirePlan } from "@/lib/auth/require-plan";
import { requireRole } from "@/lib/auth/require-role";
import { assertVenueVisible } from "@/lib/auth/venue-scope";
import { venues } from "@/lib/db/schema";
import { verifyOAuthState } from "@/lib/oauth/google";
import { upsertPosConnection } from "@/lib/pos/connection";
import { exchangeSquareCode, isSquareConfigured } from "@/lib/pos/square/oauth";
import { audit } from "@/lib/server/admin/audit";
import { adminDb } from "@/lib/server/admin/db";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const STATE_COOKIE = "tk_square_oauth_state";

function backTo(appUrl: string, venueId: string | null, flash: string): NextResponse {
  const dest = venueId
    ? new URL(`/dashboard/venues/${venueId}/settings/pos?square=${flash}`, appUrl)
    : new URL(`/dashboard/venues?square=${flash}`, appUrl);
  return NextResponse.redirect(dest);
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const appUrl = process.env["NEXT_PUBLIC_APP_URL"] ?? `${url.protocol}//${url.host}`;
  const code = url.searchParams.get("code");
  const stateParam = url.searchParams.get("state");
  const errorParam = url.searchParams.get("error");

  if (errorParam) return backTo(appUrl, null, "denied");
  if (!code || !stateParam) return backTo(appUrl, null, "bad-request");
  if (!isSquareConfigured()) return backTo(appUrl, null, "disabled");

  const cookie = req.cookies.get(STATE_COOKIE)?.value;
  if (!cookie || cookie !== stateParam) return backTo(appUrl, null, "state-mismatch");

  const verified = verifyOAuthState(stateParam);
  if (!verified.ok) return backTo(appUrl, null, "state-invalid");
  const { venueId, userId: stateUserId } = verified.payload;

  const { userId, orgId } = await requireRole("manager");
  if (userId !== stateUserId) return backTo(appUrl, venueId, "user-mismatch");

  // Re-assert the Plus gate + venue scope at callback time.
  try {
    await requirePlan(orgId, "plus");
  } catch {
    return backTo(appUrl, venueId, "plus-required");
  }
  if (!(await assertVenueVisible(venueId))) {
    return backTo(appUrl, null, "venue-not-found");
  }

  // Resolve the org from the venue (under admin — RLS-checked above).
  const [venue] = await adminDb()
    .select({ organisationId: venues.organisationId })
    .from(venues)
    .where(eq(venues.id, venueId))
    .limit(1);
  if (!venue) return backTo(appUrl, null, "venue-not-found");

  let tokens;
  try {
    tokens = await exchangeSquareCode({ code, appUrl });
  } catch {
    // Never echo the underlying error — it can include the bad code.
    return backTo(appUrl, venueId, "exchange-failed");
  }

  await upsertPosConnection({
    organisationId: venue.organisationId,
    venueId,
    provider: "square",
    externalAccountId: tokens.merchantId,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    tokenExpiresAt: tokens.expiresAt,
    createdByUserId: userId,
  });

  await audit.log({
    organisationId: venue.organisationId,
    actorUserId: userId,
    action: "pos.connection.created",
    targetType: "venue",
    targetId: venueId,
    metadata: { provider: "square" },
  });

  const res = backTo(appUrl, venueId, "connected");
  res.cookies.delete(STATE_COOKIE);
  return res;
}
