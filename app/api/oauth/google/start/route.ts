// Kicks off the Google OAuth flow for a venue. Operator (manager+)
// posts here from the venue settings page; we mint a signed state
// token, drop a same-value HttpOnly cookie for CSRF binding, and
// redirect to Google's consent screen. Callback route does the swap.

import { NextResponse, type NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { authorizeUrl, isConfigured, signOAuthState } from "@/lib/oauth/google";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const STATE_COOKIE = "tk_google_oauth_state";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const venueId = url.searchParams.get("venueId");
  if (!venueId) return NextResponse.json({ error: "venueId required" }, { status: 400 });

  // Manager+ only — connecting a third-party account is a privileged
  // org-level action, not something hosts should be able to do.
  const { userId } = await requireRole("manager");

  if (!isConfigured()) {
    return NextResponse.json({ error: "google-oauth-disabled" }, { status: 503 });
  }

  const state = signOAuthState({ venueId, userId });
  const appUrl = process.env["NEXT_PUBLIC_APP_URL"] ?? `${url.protocol}//${url.host}`;
  const redirect = authorizeUrl({ state, appUrl });
  if (!redirect) return NextResponse.json({ error: "google-oauth-disabled" }, { status: 503 });

  const res = NextResponse.redirect(redirect);
  // Cookie is the CSRF binding — same value as the state in the URL.
  // If the callback's cookie value doesn't match the URL state, an
  // attacker is replaying a state from elsewhere. 10 min TTL to match
  // the state-token expiry.
  res.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: !url.host.startsWith("localhost"),
    path: "/api/oauth/google",
    maxAge: 10 * 60,
  });
  return res;
}
