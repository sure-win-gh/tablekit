// Kicks off the Square (Connect) OAuth flow for a venue. Manager+ posts
// here from the POS settings page; we Plus-gate, mint a signed state token,
// drop a CSRF cookie, and redirect to Square's consent screen with
// read-only scopes. The callback route does the code-for-token swap.

import { NextResponse, type NextRequest } from "next/server";

import { InsufficientPlanError, requirePlan } from "@/lib/auth/require-plan";
import { requireRole } from "@/lib/auth/require-role";
import { assertVenueVisible } from "@/lib/auth/venue-scope";
import { signOAuthState } from "@/lib/oauth/google";
import { isSquareConfigured, squareAuthorizeUrl } from "@/lib/pos/square/oauth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const STATE_COOKIE = "tk_square_oauth_state";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const venueId = url.searchParams.get("venueId");
  if (!venueId) return NextResponse.json({ error: "venueId required" }, { status: 400 });

  // Manager+ only — connecting a till is a privileged org-level action.
  const { userId, orgId } = await requireRole("manager");

  // Plus-tier feature.
  try {
    await requirePlan(orgId, "plus");
  } catch (e) {
    if (e instanceof InsufficientPlanError) {
      return NextResponse.json({ error: "plus-required" }, { status: 403 });
    }
    throw e;
  }

  // Per-venue scope — a manager in org A mustn't mint state for a venue id
  // they can't see (routes through RLS).
  if (!(await assertVenueVisible(venueId))) {
    return NextResponse.json({ error: "venue-not-found" }, { status: 404 });
  }

  if (!isSquareConfigured()) {
    return NextResponse.json({ error: "square-oauth-disabled" }, { status: 503 });
  }

  const state = signOAuthState({ venueId, userId });
  const appUrl = process.env["NEXT_PUBLIC_APP_URL"] ?? `${url.protocol}//${url.host}`;
  const redirect = squareAuthorizeUrl({ state, appUrl });
  if (!redirect) return NextResponse.json({ error: "square-oauth-disabled" }, { status: 503 });

  const res = NextResponse.redirect(redirect);
  res.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: !url.host.startsWith("localhost"),
    path: "/api/oauth/square",
    maxAge: 10 * 60,
  });
  return res;
}
