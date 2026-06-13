// Square OAuth (Connect) + read-only API client.
//
// Scopes are READ-ONLY — we never request write/refund scopes (PCI + spec
// security check). State signing reuses the app's signed-state helper from
// lib/oauth/google (generic venueId.userId.iat HMAC), so we don't reinvent
// CSRF binding.

import "server-only";

// Read-only scopes only. Asserted by the security review + a test.
export const SQUARE_SCOPES = [
  "PAYMENTS_READ",
  "ORDERS_READ",
  "MERCHANT_PROFILE_READ",
  "CUSTOMERS_READ",
] as const;

const SQUARE_VERSION = "2025-01-23";

export function squareApiBase(): string {
  return process.env["SQUARE_API_BASE"] ?? "https://connect.squareup.com";
}

export function squareClientId(): string | null {
  const v = process.env["SQUARE_CLIENT_ID"];
  if (!v || v.includes("YOUR_")) return null;
  return v;
}

export function squareClientSecret(): string | null {
  const v = process.env["SQUARE_CLIENT_SECRET"];
  if (!v || v.includes("YOUR_")) return null;
  return v;
}

export function isSquareConfigured(): boolean {
  return squareClientId() !== null && squareClientSecret() !== null;
}

export function squareRedirectUri(appUrl: string): string {
  return new URL("/api/oauth/square/callback", appUrl).toString();
}

export function squareAuthorizeUrl(input: { state: string; appUrl: string }): string | null {
  const id = squareClientId();
  if (!id) return null;
  const u = new URL("/oauth2/authorize", squareApiBase());
  u.searchParams.set("client_id", id);
  u.searchParams.set("scope", SQUARE_SCOPES.join(" "));
  u.searchParams.set("session", "false");
  u.searchParams.set("state", input.state);
  u.searchParams.set("redirect_uri", squareRedirectUri(input.appUrl));
  return u.toString();
}

export type SquareTokens = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  merchantId: string | null;
};

const FETCH_TIMEOUT_MS = 8_000;

export async function exchangeSquareCode(input: {
  code: string;
  appUrl: string;
}): Promise<SquareTokens> {
  const id = squareClientId();
  const secret = squareClientSecret();
  if (!id || !secret) throw new Error("lib/pos/square/oauth.ts: Square OAuth not configured");

  const res = await fetch(new URL("/oauth2/token", squareApiBase()), {
    method: "POST",
    headers: { "Content-Type": "application/json", "Square-Version": SQUARE_VERSION },
    body: JSON.stringify({
      client_id: id,
      client_secret: secret,
      code: input.code,
      grant_type: "authorization_code",
      redirect_uri: squareRedirectUri(input.appUrl),
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Square token exchange failed (${res.status})`);
  const json = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_at?: string;
    merchant_id?: string;
  };
  if (!json.access_token) throw new Error("Square token exchange returned malformed body");
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? null,
    expiresAt: json.expires_at ? new Date(json.expires_at) : null,
    merchantId: json.merchant_id ?? null,
  };
}

// Fetch a parent order for line items / tax. Only called when line-item
// ingest is enabled for the connection. Returns null on any failure — the
// payment-derived totals are still ingested.
export async function fetchSquareOrder(
  accessToken: string,
  orderId: string,
): Promise<import("./normalise").SquareOrder | null> {
  try {
    const res = await fetch(new URL(`/v2/orders/${orderId}`, squareApiBase()), {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Square-Version": SQUARE_VERSION,
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { order?: import("./normalise").SquareOrder };
    return json.order ?? null;
  } catch {
    return null;
  }
}
