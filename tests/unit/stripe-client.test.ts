// Unit tests for lib/stripe/client.ts.
//
// Covers the placeholder-detection defence (prevents the "running but
// broken" failure mode we hit with HCAPTCHA) + the kill switch.

import { afterEach, describe, expect, it } from "vitest";

import {
  StripeNotConfiguredError,
  _resetStripeClientForTests,
  paymentsDisabled,
  stripe,
  stripeEnabled,
} from "@/lib/stripe/client";

const originalKey = process.env["STRIPE_SECRET_KEY"];
const originalDisabled = process.env["PAYMENTS_DISABLED"];

afterEach(() => {
  if (originalKey === undefined) delete process.env["STRIPE_SECRET_KEY"];
  else process.env["STRIPE_SECRET_KEY"] = originalKey;
  if (originalDisabled === undefined) delete process.env["PAYMENTS_DISABLED"];
  else process.env["PAYMENTS_DISABLED"] = originalDisabled;
  _resetStripeClientForTests();
});

describe("stripe() client factory", () => {
  it("throws when STRIPE_SECRET_KEY is unset", () => {
    delete process.env["STRIPE_SECRET_KEY"];
    _resetStripeClientForTests();
    expect(() => stripe()).toThrow(StripeNotConfiguredError);
  });

  it("throws when STRIPE_SECRET_KEY is the placeholder", () => {
    process.env["STRIPE_SECRET_KEY"] = "sk_test_YOUR_STRIPE_SECRET_KEY";
    _resetStripeClientForTests();
    expect(() => stripe()).toThrow(StripeNotConfiguredError);
  });

  it("throws when the key isn't sk_test_ or sk_live_ shaped", () => {
    process.env["STRIPE_SECRET_KEY"] = "whsec_nottherightprefix";
    _resetStripeClientForTests();
    expect(() => stripe()).toThrow(StripeNotConfiguredError);
  });

  it("constructs a client for a real-looking sk_test_ key", () => {
    process.env["STRIPE_SECRET_KEY"] = "sk_test_51" + "a".repeat(100);
    _resetStripeClientForTests();
    const client = stripe();
    expect(client).toBeDefined();
    // Singleton — second call returns the same instance.
    expect(stripe()).toBe(client);
  });
});

describe("stripeEnabled()", () => {
  it("is false for placeholder / unset keys", () => {
    process.env["STRIPE_SECRET_KEY"] = "sk_test_YOUR_STRIPE_SECRET_KEY";
    expect(stripeEnabled()).toBe(false);
    delete process.env["STRIPE_SECRET_KEY"];
    expect(stripeEnabled()).toBe(false);
  });

  it("is true for a real-looking key", () => {
    process.env["STRIPE_SECRET_KEY"] = "sk_test_51abc";
    expect(stripeEnabled()).toBe(true);
  });
});

describe("paymentsDisabled() kill switch", () => {
  it("is false when unset", () => {
    delete process.env["PAYMENTS_DISABLED"];
    expect(paymentsDisabled()).toBe(false);
  });

  it("is false for any value other than literal 'true'", () => {
    process.env["PAYMENTS_DISABLED"] = "false";
    expect(paymentsDisabled()).toBe(false);
    process.env["PAYMENTS_DISABLED"] = "1";
    expect(paymentsDisabled()).toBe(false);
  });

  it("is true for literal 'true'", () => {
    process.env["PAYMENTS_DISABLED"] = "true";
    expect(paymentsDisabled()).toBe(true);
  });
});
