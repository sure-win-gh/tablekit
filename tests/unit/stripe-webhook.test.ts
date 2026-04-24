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

const originalSecretKey = process.env["STRIPE_SECRET_KEY"];
const originalWebhookSecret = process.env["STRIPE_WEBHOOK_SECRET"];

beforeEach(() => {
  process.env["STRIPE_SECRET_KEY"] = FAKE_STRIPE_SECRET_KEY;
  process.env["STRIPE_WEBHOOK_SECRET"] = FAKE_WEBHOOK_SECRET;
  _resetStripeClientForTests();
  _clearHandlersForTests();
});

afterEach(() => {
  if (originalSecretKey === undefined) delete process.env["STRIPE_SECRET_KEY"];
  else process.env["STRIPE_SECRET_KEY"] = originalSecretKey;
  if (originalWebhookSecret === undefined) delete process.env["STRIPE_WEBHOOK_SECRET"];
  else process.env["STRIPE_WEBHOOK_SECRET"] = originalWebhookSecret;
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
