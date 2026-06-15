// Lightspeed webhook signature verification.
//
// Lightspeed signs the raw body with HMAC-SHA256 keyed by the per-connection
// webhook secret (stored encrypted in pos_connections.webhook_secret_cipher),
// hex-encoded, in the signature header. We compare in constant time. The
// exact header name is confirmed at partner onboarding — provisional below.

import { createHmac } from "node:crypto";

import { constantTimeEqual } from "@/lib/security/crypto";

export const LIGHTSPEED_SIGNATURE_HEADER = "x-ls-signature";

export function computeLightspeedSignature(secret: string, rawBody: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

export function verifyLightspeedSignature(params: {
  signatureHeader: string | null;
  secret: string;
  rawBody: string;
}): boolean {
  const { signatureHeader, secret, rawBody } = params;
  if (!signatureHeader) return false;
  return constantTimeEqual(signatureHeader, computeLightspeedSignature(secret, rawBody));
}
