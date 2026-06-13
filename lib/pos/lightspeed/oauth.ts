// Lightspeed Restaurant (K-Series) OAuth + config.
//
// PARTNER-GATED. Lightspeed K-Series API access requires Tablekit to be an
// approved Lightspeed partner — a go-live dependency tracked in the build
// plan. Everything here stays behind LIGHTSPEED_PARTNER_ENABLED=true; with
// the flag off the connect flow + webhook are disabled. Scopes are
// read-only. Exact endpoints/scope strings are confirmed at partner
// onboarding — treat the values below as provisional but the shape as fixed.

import "server-only";

// Read-only scopes only — never request write/refund scopes.
export const LIGHTSPEED_SCOPES = ["employee:register_read", "employee:financial_read"] as const;

export function isLightspeedEnabled(): boolean {
  return process.env["LIGHTSPEED_PARTNER_ENABLED"] === "true";
}

export function lightspeedApiBase(): string {
  return process.env["LIGHTSPEED_API_BASE"] ?? "https://api.lightspeedapp.com";
}

export function lightspeedClientId(): string | null {
  const v = process.env["LIGHTSPEED_CLIENT_ID"];
  if (!v || v.includes("YOUR_")) return null;
  return v;
}

export function lightspeedClientSecret(): string | null {
  const v = process.env["LIGHTSPEED_CLIENT_SECRET"];
  if (!v || v.includes("YOUR_")) return null;
  return v;
}

export function isLightspeedConfigured(): boolean {
  return (
    isLightspeedEnabled() && lightspeedClientId() !== null && lightspeedClientSecret() !== null
  );
}

export function lightspeedRedirectUri(appUrl: string): string {
  return new URL("/api/oauth/lightspeed/callback", appUrl).toString();
}

export function lightspeedAuthorizeUrl(input: { state: string; appUrl: string }): string | null {
  const id = lightspeedClientId();
  if (!id || !isLightspeedEnabled()) return null;
  const u = new URL("/oauth/authorize", lightspeedApiBase());
  u.searchParams.set("client_id", id);
  u.searchParams.set("scope", LIGHTSPEED_SCOPES.join(" "));
  u.searchParams.set("response_type", "code");
  u.searchParams.set("state", input.state);
  u.searchParams.set("redirect_uri", lightspeedRedirectUri(input.appUrl));
  return u.toString();
}

export type LightspeedTokens = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  businessId: string | null;
  webhookSecret: string | null;
};

const FETCH_TIMEOUT_MS = 8_000;

export async function exchangeLightspeedCode(input: {
  code: string;
  appUrl: string;
}): Promise<LightspeedTokens> {
  const id = lightspeedClientId();
  const secret = lightspeedClientSecret();
  if (!id || !secret) throw new Error("lib/pos/lightspeed/oauth.ts: not configured");

  const res = await fetch(new URL("/oauth/token", lightspeedApiBase()), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: id,
      client_secret: secret,
      code: input.code,
      grant_type: "authorization_code",
      redirect_uri: lightspeedRedirectUri(input.appUrl),
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Lightspeed token exchange failed (${res.status})`);
  const json = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    business_id?: string;
    webhook_secret?: string;
  };
  if (!json.access_token) throw new Error("Lightspeed token exchange returned malformed body");
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? null,
    expiresAt: json.expires_in ? new Date(Date.now() + json.expires_in * 1000) : null,
    businessId: json.business_id ?? null,
    webhookSecret: json.webhook_secret ?? null,
  };
}

// Refresh an access token. Throws on failure (caller marks the connection
// errored). The webhook secret + business id don't change on refresh.
export async function refreshLightspeedToken(refreshToken: string): Promise<LightspeedTokens> {
  const id = lightspeedClientId();
  const secret = lightspeedClientSecret();
  if (!id || !secret) throw new Error("lib/pos/lightspeed/oauth.ts: not configured");

  const res = await fetch(new URL("/oauth/token", lightspeedApiBase()), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: id,
      client_secret: secret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Lightspeed token refresh failed (${res.status})`);
  const json = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!json.access_token) throw new Error("Lightspeed token refresh returned malformed body");
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? refreshToken,
    expiresAt: json.expires_in ? new Date(Date.now() + json.expires_in * 1000) : null,
    businessId: null,
    webhookSecret: null,
  };
}
