// Lightspeed OAuth redirect target. Same flow as the Square callback, plus
// the partner-flag gate. Stores the access/refresh tokens AND the webhook
// secret (used to verify inbound webhooks) encrypted on the connection.

import { eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { requirePlan } from "@/lib/auth/require-plan";
import { requireRole } from "@/lib/auth/require-role";
import { assertVenueVisible } from "@/lib/auth/venue-scope";
import { venues } from "@/lib/db/schema";
import { verifyOAuthState } from "@/lib/oauth/google";
import { upsertPosConnection } from "@/lib/pos/connection";
import { exchangeLightspeedCode, isLightspeedConfigured } from "@/lib/pos/lightspeed/oauth";
import { audit } from "@/lib/server/admin/audit";
import { adminDb } from "@/lib/server/admin/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const STATE_COOKIE = "tk_lightspeed_oauth_state";

function backTo(appUrl: string, venueId: string | null, flash: string): NextResponse {
  const dest = venueId
    ? new URL(`/dashboard/venues/${venueId}/settings/pos?lightspeed=${flash}`, appUrl)
    : new URL(`/dashboard/venues?lightspeed=${flash}`, appUrl);
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
  if (!isLightspeedConfigured()) return backTo(appUrl, null, "disabled");

  const cookie = req.cookies.get(STATE_COOKIE)?.value;
  if (!cookie || cookie !== stateParam) return backTo(appUrl, null, "state-mismatch");

  const verified = verifyOAuthState(stateParam);
  if (!verified.ok) return backTo(appUrl, null, "state-invalid");
  const { venueId, userId: stateUserId } = verified.payload;

  const { userId, orgId } = await requireRole("manager");
  if (userId !== stateUserId) return backTo(appUrl, venueId, "user-mismatch");

  try {
    await requirePlan(orgId, "plus");
  } catch {
    return backTo(appUrl, venueId, "plus-required");
  }
  if (!(await assertVenueVisible(venueId))) {
    return backTo(appUrl, null, "venue-not-found");
  }

  const [venue] = await adminDb()
    .select({ organisationId: venues.organisationId })
    .from(venues)
    .where(eq(venues.id, venueId))
    .limit(1);
  if (!venue) return backTo(appUrl, null, "venue-not-found");

  let tokens;
  try {
    tokens = await exchangeLightspeedCode({ code, appUrl });
  } catch {
    return backTo(appUrl, venueId, "exchange-failed");
  }

  await upsertPosConnection({
    organisationId: venue.organisationId,
    venueId,
    provider: "lightspeed_k",
    externalAccountId: tokens.businessId,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    tokenExpiresAt: tokens.expiresAt,
    webhookSecret: tokens.webhookSecret,
    createdByUserId: userId,
  });

  await audit.log({
    organisationId: venue.organisationId,
    actorUserId: userId,
    action: "pos.connection.created",
    targetType: "venue",
    targetId: venueId,
    metadata: { provider: "lightspeed_k" },
  });

  const res = backTo(appUrl, venueId, "connected");
  res.cookies.delete(STATE_COOKIE);
  return res;
}
