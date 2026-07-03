// Unit tests for lib/stripe/webhook.ts.
//
// Signature verification and dispatch are pure-ish — no DB touched in
// these cases. The idempotent-insert + markHandled round-trip is
// covered in tests/integration/rls-stripe-accounts.test.ts where we
// have a real database.

import { createHmac } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { _resetStripeClientForTests } from "@/lib/stripe/client";
import {
  WebhookSecretMissingError,
  WebhookSignatureError,
  _clearHandlersForTests,
  dispatch,
  getHandler,
  registerHandler,
  verifyAndParse,
} from "@/lib/stripe/webhook";

// Use a Stripe-real-looking test key so the client constructs cleanly.
// The signature verification itself just needs the secret — the
// webhook helper uses the Stripe SDK internally.
const FAKE_STRIPE_SECRET_KEY = "sk_test_51" + "a".repeat(100);
const FAKE_WEBHOOK_SECRET = "whsec_" + "a".repeat(40);

// Helper — Stripe signs webhooks as
//   Stripe-Signature: t=<ts>,v1=<hmac_sha256(ts + "." + body, secret)>
function sign(body: string, secret: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const signedPayload = `${timestamp}.${body}`;
  const mac = createHmac("sha256", secret).update(signedPayload).digest("hex");
  return `t=${timestamp},v1=${mac}`;
}

const ENV_KEYS = [
  "STRIPE_SECRET_KEY",
  "STRIPE_SECRET_KEY_UK",
  "STRIPE_SECRET_KEY_US",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_WEBHOOK_SECRET_UK",
  "STRIPE_WEBHOOK_SECRET_US",
] as const;
const original = new Map<string, string | undefined>(ENV_KEYS.map((k) => [k, process.env[k]]));

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  process.env["STRIPE_SECRET_KEY"] = FAKE_STRIPE_SECRET_KEY;
  process.env["STRIPE_WEBHOOK_SECRET"] = FAKE_WEBHOOK_SECRET;
  _resetStripeClientForTests();
  _clearHandlersForTests();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = original.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  _resetStripeClientForTests();
  _clearHandlersForTests();
});

describe("verifyAndParse", () => {
  const body = JSON.stringify({
    id: "evt_test_1",
    type: "account.updated",
    data: { object: { id: "acct_test", charges_enabled: true } },
  });

  it("parses a correctly-signed event", () => {
    const sig = sign(body, FAKE_WEBHOOK_SECRET);
    const event = verifyAndParse(body, sig);
    expect(event.id).toBe("evt_test_1");
    expect(event.type).toBe("account.updated");
  });

  it("throws WebhookSignatureError on a missing signature", () => {
    expect(() => verifyAndParse(body, null)).toThrow(WebhookSignatureError);
  });

  it("throws WebhookSignatureError on a bad signature", () => {
    const sig = sign(body, "whsec_" + "b".repeat(40));
    expect(() => verifyAndParse(body, sig)).toThrow(WebhookSignatureError);
  });

  it("throws WebhookSecretMissingError when STRIPE_WEBHOOK_SECRET is unset", () => {
    delete process.env["STRIPE_WEBHOOK_SECRET"];
    const sig = sign(body, FAKE_WEBHOOK_SECRET);
    expect(() => verifyAndParse(body, sig)).toThrow(WebhookSecretMissingError);
  });

  it("throws WebhookSecretMissingError when STRIPE_WEBHOOK_SECRET is the placeholder", () => {
    process.env["STRIPE_WEBHOOK_SECRET"] = "whsec_YOUR_STRIPE_WEBHOOK_SECRET";
    const sig = sign(body, FAKE_WEBHOOK_SECRET);
    expect(() => verifyAndParse(body, sig)).toThrow(WebhookSecretMissingError);
  });
});

describe("entity keying (multi-region Phase 2)", () => {
  const body = JSON.stringify({
    id: "evt_entity_1",
    type: "account.updated",
    data: { object: {} },
  });
  const UK_SECRET = "whsec_uk" + "u".repeat(38);
  const US_SECRET = "whsec_us" + "s".repeat(38);

  it("uk prefers STRIPE_WEBHOOK_SECRET_UK over the legacy name", () => {
    process.env["STRIPE_WEBHOOK_SECRET_UK"] = UK_SECRET;
    // Signed with the _UK secret → verifies; the legacy secret would fail.
    const sig = sign(body, UK_SECRET);
    expect(verifyAndParse(body, sig, "uk").id).toBe("evt_entity_1");
    const legacySig = sign(body, FAKE_WEBHOOK_SECRET);
    expect(() => verifyAndParse(body, legacySig, "uk")).toThrow(WebhookSignatureError);
  });

  it("uk falls back to the legacy STRIPE_WEBHOOK_SECRET (alias)", () => {
    const sig = sign(body, FAKE_WEBHOOK_SECRET);
    expect(verifyAndParse(body, sig, "uk").id).toBe("evt_entity_1");
  });

  it("us FAILS CLOSED without STRIPE_WEBHOOK_SECRET_US — never verifies against UK secrets", () => {
    process.env["STRIPE_SECRET_KEY_US"] = "sk_test_us" + "b".repeat(90);
    process.env["STRIPE_WEBHOOK_SECRET_UK"] = UK_SECRET;
    const sig = sign(body, UK_SECRET);
    expect(() => verifyAndParse(body, sig, "us")).toThrow(WebhookSecretMissingError);

    process.env["STRIPE_WEBHOOK_SECRET_US"] = US_SECRET;
    // A UK-signed payload still fails against the US secret…
    expect(() => verifyAndParse(body, sig, "us")).toThrow(WebhookSignatureError);
    // …and a US-signed payload verifies.
    expect(verifyAndParse(body, sign(body, US_SECRET), "us").id).toBe("evt_entity_1");
  });
});

describe("handler registry", () => {
  it("dispatch returns 'no-handler' when none is registered", async () => {
    const event = { id: "evt_x", type: "payment_intent.succeeded" } as never;
    await expect(dispatch(event)).resolves.toBe("no-handler");
  });

  it("registerHandler + getHandler round-trips", () => {
    const fn = async () => undefined;
    registerHandler("account.updated", fn);
    expect(getHandler("account.updated")).toBe(fn);
  });
});
