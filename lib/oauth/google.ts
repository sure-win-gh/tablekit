// Google OAuth client for the Business Profile API. Native fetch — no
// googleapis SDK — so the surface stays small and Edge-portable.
//
// Flow:
//   1. operator clicks "Connect Google" → /api/oauth/google/start
//      mints a signed state token, drops it in a cookie, redirects to
//      Google's authorize URL.
//   2. Google → /api/oauth/google/callback with ?code & ?state.
//      Callback validates state against the cookie, exchanges the code
//      for {access_token, refresh_token, expires_in, scope}, and
//      persists encrypted via lib/security/crypto.ts into
//      venue_oauth_connections.
//
// Real GBP review pull / reply post lands in Phase 3b — this module
// just owns the OAuth dance + the token-refresh primitive.

import "server-only";

import { Buffer } from "node:buffer";

import { constantTimeEqual, hashForLookup } from "@/lib/security/crypto";

// Scopes for review read + reply on Google Business Profile.
// Reference: developers.google.com/my-business/content/review-data
export const GOOGLE_OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/business.manage",
];

// State payload — bound to the operator's session at start, verified
// at callback. Includes iat so we can reject stale states (10 min TTL).
export type OAuthStatePayload = {
  venueId: string;
  userId: string;
  iat: number;
};

const STATE_MAX_AGE_S = 10 * 60;

export function clientId(): string | null {
  const v = process.env["GOOGLE_OAUTH_CLIENT_ID"];
  if (!v || v.includes("YOUR_")) return null;
  return v;
}

export function clientSecret(): string | null {
  const v = process.env["GOOGLE_OAUTH_CLIENT_SECRET"];
  if (!v || v.includes("YOUR_")) return null;
  return v;
}

export function isConfigured(): boolean {
  return clientId() !== null && clientSecret() !== null;
}

export function redirectUri(appUrl: string): string {
  return new URL("/api/oauth/google/callback", appUrl).toString();
}

// --- State token --------------------------------------------------------------

function encodeState(p: OAuthStatePayload): string {
  return Buffer.from(`${p.venueId}.${p.userId}.${p.iat}`, "utf8").toString("base64url");
}

function decodeState(encoded: string): OAuthStatePayload | null {
  try {
    const decoded = Buffer.from(encoded, "base64url").toString("utf8");
    const parts = decoded.split(".");
    if (parts.length !== 3) return null;
    const [venueId, userId, iatRaw] = parts as [string, string, string];
    const iat = Number(iatRaw);
    if (!venueId || !userId || !Number.isFinite(iat) || iat <= 0) return null;
    return { venueId, userId, iat };
  } catch {
    return null;
  }
}

export function signOAuthState(input: { venueId: string; userId: string; iat?: number }): string {
  const iat = input.iat ?? Math.floor(Date.now() / 1000);
  const payload = encodeState({ venueId: input.venueId, userId: input.userId, iat });
  const sig = hashForLookup(payload, "raw");
  return `${payload}.${sig}`;
}

export type OAuthStateVerifyError = "bad-format" | "bad-sig" | "expired" | "future";

export function verifyOAuthState(
  combined: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
):
  | { ok: true; payload: OAuthStatePayload }
  | { ok: false; reason: OAuthStateVerifyError } {
  const lastDot = combined.lastIndexOf(".");
  if (lastDot <= 0) return { ok: false, reason: "bad-format" };
  const payload = combined.slice(0, lastDot);
  const sig = combined.slice(lastDot + 1);
  if (!constantTimeEqual(hashForLookup(payload, "raw"), sig)) {
    return { ok: false, reason: "bad-sig" };
  }
  const decoded = decodeState(payload);
  if (!decoded) return { ok: false, reason: "bad-format" };
  if (decoded.iat > nowSeconds + 5 * 60) return { ok: false, reason: "future" };
  if (nowSeconds - decoded.iat > STATE_MAX_AGE_S) return { ok: false, reason: "expired" };
  return { ok: true, payload: decoded };
}

// --- Authorize URL -----------------------------------------------------------

export function authorizeUrl(input: { state: string; appUrl: string }): string | null {
  const id = clientId();
  if (!id) return null;
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.searchParams.set("client_id", id);
  u.searchParams.set("redirect_uri", redirectUri(input.appUrl));
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", GOOGLE_OAUTH_SCOPES.join(" "));
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  u.searchParams.set("state", input.state);
  return u.toString();
}

// --- Token exchange + refresh -----------------------------------------------

export type TokenResponse = {
  accessToken: string;
  refreshToken: string | null;
  expiresInSeconds: number;
  scope: string;
};

// 8s is generous for Google's token + Business Profile endpoints —
// most return well under a second; we want the cron / page render to
// fail fast on a stalled API rather than holding a worker open until
// Vercel times out the function.
export const GOOGLE_FETCH_TIMEOUT_MS = 8_000;

export async function refreshAccessToken(input: {
  refreshToken: string;
}): Promise<{ accessToken: string; expiresInSeconds: number }> {
  const id = clientId();
  const secret = clientSecret();
  if (!id || !secret) throw new Error("Google OAuth not configured");
  const body = new URLSearchParams({
    client_id: id,
    client_secret: secret,
    refresh_token: input.refreshToken,
    grant_type: "refresh_token",
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(GOOGLE_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    // Status only — body can echo the refresh token in some error
    // shapes, never log it.
    throw new Error(`Google token refresh failed: ${res.status}`);
  }
  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token || typeof json.expires_in !== "number") {
    throw new Error("Google token refresh returned malformed body");
  }
  return { accessToken: json.access_token, expiresInSeconds: json.expires_in };
}

export async function exchangeCodeForTokens(input: {
  code: string;
  appUrl: string;
}): Promise<TokenResponse> {
  const id = clientId();
  const secret = clientSecret();
  if (!id || !secret) throw new Error("Google OAuth not configured");
  const body = new URLSearchParams({
    code: input.code,
    client_id: id,
    client_secret: secret,
    redirect_uri: redirectUri(input.appUrl),
    grant_type: "authorization_code",
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(GOOGLE_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    // Body may include error_description with the bad code echoed back —
    // surface only the status. Never log the response text raw.
    throw new Error(`Google token exchange failed: ${res.status}`);
  }
  const json = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };
  if (!json.access_token || typeof json.expires_in !== "number") {
    throw new Error("Google token exchange returned malformed body");
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? null,
    expiresInSeconds: json.expires_in,
    scope: json.scope ?? "",
  };
}
