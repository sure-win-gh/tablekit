// HMAC-signed "active organisation" cookie.
//
// Carries the user's currently-selected org across requests without a
// JWT re-mint (Supabase's JWT is client-refreshed; forcing a new token
// on every org switch would be slow). Signed so the client can't
// forge a different org id.
//
// Cookie shape: `${orgId}.${base64url(HMAC-SHA256(orgId, SESSION_SIGNING_SECRET))}`
// HttpOnly, Secure (in prod), SameSite=Lax, Path=/, 1-year maxAge.

import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

export const ACTIVE_ORG_COOKIE = "tk_active_org";

function signingSecret(): string {
  const secret = process.env["SESSION_SIGNING_SECRET"];
  if (!secret) {
    throw new Error(
      "lib/auth/active-org.ts: SESSION_SIGNING_SECRET is not set. See .env.local.example.",
    );
  }
  return secret;
}

function sign(value: string): string {
  return createHmac("sha256", signingSecret()).update(value).digest("base64url");
}

function verify(value: string, sig: string): boolean {
  const expected = Buffer.from(sign(value), "utf8");
  const actual = Buffer.from(sig, "utf8");
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

export async function setActiveOrg(orgId: string): Promise<void> {
  const sig = sign(orgId);
  const cookieStore = await cookies();
  cookieStore.set({
    name: ACTIVE_ORG_COOKIE,
    value: `${orgId}.${sig}`,
    httpOnly: true,
    secure: process.env["NODE_ENV"] === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
}

export async function getActiveOrg(): Promise<string | null> {
  const cookieStore = await cookies();
  const raw = cookieStore.get(ACTIVE_ORG_COOKIE)?.value;
  if (!raw) return null;
  const firstDot = raw.indexOf(".");
  if (firstDot <= 0) return null;
  const orgId = raw.slice(0, firstDot);
  const sig = raw.slice(firstDot + 1);
  if (!verify(orgId, sig)) return null;
  return orgId;
}

export async function clearActiveOrg(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(ACTIVE_ORG_COOKIE);
}
