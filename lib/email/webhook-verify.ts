// Resend webhook signature verification (Svix-format).
//
// Resend signs every webhook with HMAC-SHA256:
//   sig_hex = hmac(secret, `${svix-id}.${svix-timestamp}.${body}`)
// header `svix-signature` is "v1,<base64-of-sig>" (multiple v1 entries
// possible for key rotation; any match is enough).
//
// Secret format: "whsec_<base64>" — we strip the prefix and base64-
// decode for the HMAC key.

import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

export class ResendWebhookSecretMissingError extends Error {
  constructor() {
    super("lib/email/webhook-verify.ts: RESEND_WEBHOOK_SECRET not set or placeholder.");
    this.name = "ResendWebhookSecretMissingError";
  }
}

export class ResendWebhookSignatureError extends Error {
  constructor() {
    super("lib/email/webhook-verify.ts: signature verification failed");
    this.name = "ResendWebhookSignatureError";
  }
}

function resolveSecret(): Buffer {
  const raw = process.env["RESEND_WEBHOOK_SECRET"];
  if (!raw || raw.includes("YOUR_") || !raw.startsWith("whsec_")) {
    throw new ResendWebhookSecretMissingError();
  }
  return Buffer.from(raw.replace(/^whsec_/, ""), "base64");
}

export function verifyResendWebhook({
  body,
  svixId,
  svixTimestamp,
  svixSignature,
}: {
  body: string;
  svixId: string | null;
  svixTimestamp: string | null;
  svixSignature: string | null;
}): void {
  if (!svixId || !svixTimestamp || !svixSignature) {
    throw new ResendWebhookSignatureError();
  }
  const key = resolveSecret();
  const expected = createHmac("sha256", key).update(`${svixId}.${svixTimestamp}.${body}`).digest();
  // The header is "v1,<sig> v1,<sig2>" — one space-separated entry per
  // signing key (Svix supports rotation). Any match is enough.
  const candidates = svixSignature
    .split(" ")
    .map((s) => s.trim())
    .filter((s) => s.startsWith("v1,"))
    .map((s) => Buffer.from(s.slice(3), "base64"));
  for (const candidate of candidates) {
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) return;
  }
  throw new ResendWebhookSignatureError();
}
