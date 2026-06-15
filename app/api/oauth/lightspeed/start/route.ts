// Kicks off the Lightspeed (K-Series) OAuth flow for a venue. Same shape as
// the Square start route, but additionally gated behind the partner flag —
// 503 until LIGHTSPEED_PARTNER_ENABLED=true and credentials are configured.

import { NextResponse, type NextRequest } from "next/server";

import { InsufficientPlanError, requirePlan } from "@/lib/auth/require-plan";
import { requireRole } from "@/lib/auth/require-role";
import { assertVenueVisible } from "@/lib/auth/venue-scope";
import { signOAuthState } from "@/lib/oauth/google";
import { isLightspeedConfigured, lightspeedAuthorizeUrl } from "@/lib/pos/lightspeed/oauth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const STATE_COOKIE = "tk_lightspeed_oauth_state";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const venueId = url.searchParams.get("venueId");
  if (!venueId) return NextResponse.json({ error: "venueId required" }, { status: 400 });

  const { userId, orgId } = await requireRole("manager");

  try {
    await requirePlan(orgId, "plus");
  } catch (e) {
    if (e instanceof InsufficientPlanError) {
      return NextResponse.json({ error: "plus-required" }, { status: 403 });
    }
    throw e;
  }

  if (!(await assertVenueVisible(venueId))) {
    return NextResponse.json({ error: "venue-not-found" }, { status: 404 });
  }

  if (!isLightspeedConfigured()) {
    return NextResponse.json({ error: "lightspeed-disabled" }, { status: 503 });
  }

  const state = signOAuthState({ venueId, userId });
  const appUrl = process.env["NEXT_PUBLIC_APP_URL"] ?? `${url.protocol}//${url.host}`;
  const redirect = lightspeedAuthorizeUrl({ state, appUrl });
  if (!redirect) return NextResponse.json({ error: "lightspeed-disabled" }, { status: 503 });

  const res = NextResponse.redirect(redirect);
  res.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: !url.host.startsWith("localhost"),
    path: "/api/oauth/lightspeed",
    maxAge: 10 * 60,
  });
  return res;
}
