// Square webhook signature verification.
//
// Square signs each notification with HMAC-SHA256 over the exact string
// (notificationURL + rawBody), keyed by the subscription's signature key,
// base64-encoded, in the `x-square-hmacsha256-signature` header. We compare
// in constant time. The signature key is an app-level secret from env
// (SQUARE_WEBHOOK_SIGNATURE_KEY) — distinct from a connection's OAuth token.
//
// Ref: Square "Validate notifications" — HMAC-SHA256(notificationURL+body).

import { createHmac } from "node:crypto";

import { constantTimeEqual } from "@/lib/security/crypto";

export const SQUARE_SIGNATURE_HEADER = "x-square-hmacsha256-signature";

export function squareSignatureKey(): string | null {
  const v = process.env["SQUARE_WEBHOOK_SIGNATURE_KEY"];
  if (!v || v.includes("YOUR_")) return null;
  return v;
}

// The exact public URL Square is configured to POST to — it is part of the
// signed string, so it must match the registered endpoint byte-for-byte.
export function squareNotificationUrl(): string | null {
  const v = process.env["SQUARE_WEBHOOK_URL"];
  if (!v || v.includes("YOUR_")) return null;
  return v;
}

export function computeSquareSignature(
  signatureKey: string,
  notificationUrl: string,
  rawBody: string,
): string {
  return createHmac("sha256", signatureKey)
    .update(notificationUrl + rawBody)
    .digest("base64");
}

export type VerifySquareParams = {
  signatureHeader: string | null;
  signatureKey: string;
  notificationUrl: string;
  rawBody: string;
};

export function verifySquareSignature(params: VerifySquareParams): boolean {
  const { signatureHeader, signatureKey, notificationUrl, rawBody } = params;
  if (!signatureHeader) return false;
  const expected = computeSquareSignature(signatureKey, notificationUrl, rawBody);
  // constantTimeEqual already length-guards before timingSafeEqual.
  return constantTimeEqual(signatureHeader, expected);
}
