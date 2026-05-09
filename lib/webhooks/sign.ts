// HMAC-SHA256 signing for outbound webhook deliveries.
//
// The subscriber gets `X-TableKit-Signature: sha256=<hex>` on every
// delivery. They verify by recomputing HMAC over the raw response
// body using the shared secret we showed them once at registration.
//
// Note: `sha256=` prefix matches GitHub / Stripe / many standards.
// The body is the EXACT bytes we POSTed; if a subscriber JSON-parses
// then re-stringifies before verifying, they may produce a different
// HMAC due to whitespace + key-ordering. Our docs (PR5 OpenAPI) will
// note this.

import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

const SCHEME = "sha256";

export function signBody(secret: string, body: string): string {
  const mac = createHmac("sha256", secret);
  mac.update(body, "utf8");
  return `${SCHEME}=${mac.digest("hex")}`;
}

// Constant-time compare. Exposed for tests + for any future inbound
// webhook (e.g. someone subscribing to OUR own events for testing).
export function verifySignature(secret: string, body: string, signature: string): boolean {
  const expected = signBody(secret, body);
  if (expected.length !== signature.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}
