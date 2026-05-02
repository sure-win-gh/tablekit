// Resend INBOUND webhook signature verification.
//
// Same Svix HMAC-SHA256 scheme as the outbound webhook (see
// `./webhook-verify.ts` — kept separate because the two webhooks use
// distinct signing secrets in the Resend console; conflating them
// would invite a copy-paste bug). The core HMAC step is identical;
// only the env var changes.

import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

export class ResendInboundSecretMissingError extends Error {
  constructor() {
    super("lib/email/inbound-verify.ts: RESEND_INBOUND_SECRET not set or placeholder.");
    this.name = "ResendInboundSecretMissingError";
  }
}

export class ResendInboundSignatureError extends Error {
  constructor() {
    super("lib/email/inbound-verify.ts: signature verification failed");
    this.name = "ResendInboundSignatureError";
  }
}

function resolveSecret(): Buffer {
  const raw = process.env["RESEND_INBOUND_SECRET"];
  // `includes("YOUR_")` not `startsWith` — the documented placeholder
  // is `whsec_YOUR_RESEND_INBOUND_SECRET` which starts with `whsec_`,
  // so a startsWith check would let the placeholder through and
  // surface as a confusing signature mismatch downstream. Matches
  // the pattern in `webhook-verify.ts`.
  if (!raw || raw.includes("YOUR_") || !raw.startsWith("whsec_")) {
    throw new ResendInboundSecretMissingError();
  }
  return Buffer.from(raw.replace(/^whsec_/, ""), "base64");
}

export function verifyResendInboundWebhook({
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
    throw new ResendInboundSignatureError();
  }
  const key = resolveSecret();
  const expected = createHmac("sha256", key).update(`${svixId}.${svixTimestamp}.${body}`).digest();
  // Header is "v1,<sig> v1,<sig2>" — one space-separated entry per
  // signing key (Svix supports rotation). Any match is enough.
  const candidates = svixSignature
    .split(" ")
    .map((s) => s.trim())
    .filter((s) => s.startsWith("v1,"))
    .map((s) => Buffer.from(s.slice(3), "base64"));
  for (const candidate of candidates) {
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) return;
  }
  throw new ResendInboundSignatureError();
}
