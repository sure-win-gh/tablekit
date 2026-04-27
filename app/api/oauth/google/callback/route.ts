// Google OAuth redirect target. Validates the signed state token + the
// CSRF cookie binding, exchanges the authorisation code for tokens,
// encrypts them, and upserts a venue_oauth_connections row. Then
// redirects the operator back to the venue settings page with a flash
// querystring.
//
// Errors land on the same settings page with `?google=<reason>` so the
// operator gets a readable message instead of a JSON 500.

import { NextResponse, type NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { assertVenueVisible } from "@/lib/auth/venue-scope";
import { venueOauthConnections } from "@/lib/db/schema";
import { exchangeCodeForTokens, isConfigured, verifyOAuthState } from "@/lib/oauth/google";
import { audit } from "@/lib/server/admin/audit";
import { adminDb } from "@/lib/server/admin/db";
import { encryptPii } from "@/lib/security/crypto";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const STATE_COOKIE = "tk_google_oauth_state";

function backTo(appUrl: string, venueId: string | null, flash: string): NextResponse {
  const dest = venueId
    ? new URL(`/dashboard/venues/${venueId}/settings?google=${flash}`, appUrl)
    : new URL(`/dashboard/venues?google=${flash}`, appUrl);
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
  if (!isConfigured()) return backTo(appUrl, null, "disabled");

  // CSRF binding — the cookie must echo the state from the URL.
  const cookie = req.cookies.get(STATE_COOKIE)?.value;
  if (!cookie || cookie !== stateParam) return backTo(appUrl, null, "state-mismatch");

  const verified = verifyOAuthState(stateParam);
  if (!verified.ok) return backTo(appUrl, null, "state-invalid");
  const { venueId, userId: stateUserId } = verified.payload;

  // Manager+ only, and the user that finishes the flow must be the
  // same user that started it (state binding above already enforces
  // the URL signature; this catches a stolen-cookie flow).
  const { userId, orgId } = await requireRole("manager");
  if (userId !== stateUserId) return backTo(appUrl, venueId, "user-mismatch");

  // Confirm the venue is in the caller's org + per-venue scope.
  // assertVenueVisible routes through RLS so it consults
  // memberships.venue_ids — without this, the caller could craft a
  // venue id from a different org and we'd happily upsert tokens
  // against it (DoS via cross-tenant overwrite).
  if (!(await assertVenueVisible(venueId))) {
    return backTo(appUrl, null, "venue-not-found");
  }
  const db = adminDb();

  let tokens;
  try {
    tokens = await exchangeCodeForTokens({ code, appUrl });
  } catch {
    // Don't echo the underlying error — exchange failures can include
    // the bad code in the body. Operators see a generic flash.
    return backTo(appUrl, venueId, "exchange-failed");
  }

  const accessTokenCipher = await encryptPii(orgId, tokens.accessToken);
  const refreshTokenCipher = tokens.refreshToken
    ? await encryptPii(orgId, tokens.refreshToken)
    : null;
  const expiresAt = new Date(Date.now() + tokens.expiresInSeconds * 1000);

  // Upsert on (venue_id, provider) — re-connecting overwrites the
  // tokens but preserves the existing row id.
  await db
    .insert(venueOauthConnections)
    .values({
      organisationId: orgId, // overwritten by enforce trigger
      venueId,
      provider: "google",
      accessTokenCipher,
      refreshTokenCipher,
      scopes: tokens.scope,
      tokenExpiresAt: expiresAt,
    })
    .onConflictDoUpdate({
      target: [venueOauthConnections.venueId, venueOauthConnections.provider],
      set: {
        accessTokenCipher,
        refreshTokenCipher,
        scopes: tokens.scope,
        tokenExpiresAt: expiresAt,
      },
    });

  await audit.log({
    organisationId: orgId,
    actorUserId: userId,
    action: "oauth.connected",
    targetType: "venue",
    targetId: venueId,
    metadata: { provider: "google", scope: tokens.scope },
  });

  const res = backTo(appUrl, venueId, "connected");
  res.cookies.delete(STATE_COOKIE);
  return res;
}
