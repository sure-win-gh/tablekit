// Signed review-request tokens.
//
// Public review URL = /review?p=<payload>&s=<sig>.
// payload = base64url("<bookingId>.<iat>") where iat is seconds since
// epoch. sig = HMAC-SHA256(payload) via lib/security/crypto.ts#hashForLookup.
//
// The HMAC is what stops anyone forging a token. The iat lets us
// reject very old tokens — a guest who finds a year-old review email
// in their archive shouldn't be able to silently overwrite the
// venue's rating, even after first-submit-wins shipped (defence in
// depth).
//
// Verifier returns null for any of: bad sig, malformed payload, iat
// older than MAX_AGE_S, or iat in the future (skew > 5 min).
//
// TTL deliberately long (90 days) — the review email is sent at
// finished + 24h, so the token is "live" for the meaningful window
// any guest will care about, with headroom for a guest who reads the
// email after a holiday.

import "server-only";

import { Buffer } from "node:buffer";

import { constantTimeEqual, hashForLookup } from "@/lib/security/crypto";

export type ReviewTokenPayload = {
  bookingId: string;
  iat: number; // seconds since epoch
};

const MAX_AGE_S = 90 * 24 * 60 * 60; // 90 days
const MAX_FUTURE_SKEW_S = 5 * 60; // 5 minutes

function encodePayload(p: ReviewTokenPayload): string {
  return Buffer.from(`${p.bookingId}.${p.iat}`, "utf8").toString("base64url");
}

function decodePayload(encoded: string): ReviewTokenPayload | null {
  try {
    const decoded = Buffer.from(encoded, "base64url").toString("utf8");
    const lastDot = decoded.lastIndexOf(".");
    if (lastDot <= 0) return null;
    const bookingId = decoded.slice(0, lastDot);
    const iat = Number(decoded.slice(lastDot + 1));
    if (!bookingId || !Number.isFinite(iat) || iat <= 0) return null;
    return { bookingId, iat };
  } catch {
    return null;
  }
}

export function signReviewToken(input: { bookingId: string; iat?: number }): {
  p: string;
  s: string;
} {
  const iat = input.iat ?? Math.floor(Date.now() / 1000);
  const encoded = encodePayload({ bookingId: input.bookingId, iat });
  return { p: encoded, s: hashForLookup(encoded, "raw") };
}

export type ReviewTokenVerifyError = "bad-sig" | "bad-payload" | "expired" | "future";

export function verifyReviewToken(
  pEncoded: string,
  sigHex: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
):
  | { ok: true; payload: ReviewTokenPayload }
  | { ok: false; reason: ReviewTokenVerifyError } {
  const expected = hashForLookup(pEncoded, "raw");
  if (!constantTimeEqual(expected, sigHex)) return { ok: false, reason: "bad-sig" };
  const payload = decodePayload(pEncoded);
  if (!payload) return { ok: false, reason: "bad-payload" };
  if (payload.iat > nowSeconds + MAX_FUTURE_SKEW_S) return { ok: false, reason: "future" };
  if (nowSeconds - payload.iat > MAX_AGE_S) return { ok: false, reason: "expired" };
  return { ok: true, payload };
}

export function reviewUrl(
  appUrl: string,
  input: { bookingId: string; iat?: number },
  opts?: { mode?: "private" },
): string {
  const { p, s } = signReviewToken(input);
  const u = new URL("/review", appUrl);
  u.searchParams.set("p", p);
  u.searchParams.set("s", s);
  if (opts?.mode) u.searchParams.set("mode", opts.mode);
  return u.toString();
}
