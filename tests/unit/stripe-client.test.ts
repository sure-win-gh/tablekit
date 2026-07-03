// Unit tests for lib/stripe/client.ts.
//
// Covers the placeholder-detection defence (prevents the "running but
// broken" failure mode we hit with HCAPTCHA) + the kill switch.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  StripeNotConfiguredError,
  _resetStripeClientForTests,
  paymentsDisabled,
  stripe,
  stripeEnabled,
} from "@/lib/stripe/client";

const ENV_KEYS = [
  "STRIPE_SECRET_KEY",
  "STRIPE_SECRET_KEY_UK",
  "STRIPE_SECRET_KEY_US",
  "PAYMENTS_DISABLED",
] as const;
const original = new Map<string, string | undefined>(ENV_KEYS.map((k) => [k, process.env[k]]));

// Start every case from a clean multi-entity slate so the legacy
// (un-suffixed) cases below aren't perturbed by a _UK/_US value in the
// ambient env; each case then sets exactly what it needs.
beforeEach(() => {
  delete process.env["STRIPE_SECRET_KEY_UK"];
  delete process.env["STRIPE_SECRET_KEY_US"];
  _resetStripeClientForTests();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = original.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
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

describe("entity keying (multi-region Phase 2)", () => {
  const UK_KEY = "sk_test_uk" + "a".repeat(90);
  const US_KEY = "sk_test_us" + "b".repeat(90);
  const LEGACY_KEY = "sk_test_legacy" + "c".repeat(90);

  it("uk prefers STRIPE_SECRET_KEY_UK over the legacy name", () => {
    process.env["STRIPE_SECRET_KEY_UK"] = UK_KEY;
    process.env["STRIPE_SECRET_KEY"] = LEGACY_KEY;
    _resetStripeClientForTests();
    expect(stripeEnabled("uk")).toBe(true);
    expect(() => stripe("uk")).not.toThrow();
  });

  it("uk falls back to the legacy STRIPE_SECRET_KEY (alias)", () => {
    delete process.env["STRIPE_SECRET_KEY_UK"];
    process.env["STRIPE_SECRET_KEY"] = LEGACY_KEY;
    _resetStripeClientForTests();
    expect(stripeEnabled("uk")).toBe(true);
  });

  it("us FAILS CLOSED without STRIPE_SECRET_KEY_US — never falls back to a UK key", () => {
    delete process.env["STRIPE_SECRET_KEY_US"];
    process.env["STRIPE_SECRET_KEY"] = LEGACY_KEY;
    process.env["STRIPE_SECRET_KEY_UK"] = UK_KEY;
    _resetStripeClientForTests();
    expect(stripeEnabled("us")).toBe(false);
    expect(() => stripe("us")).toThrow(StripeNotConfiguredError);
  });

  it("keeps one client per entity — uk and us are distinct instances", () => {
    process.env["STRIPE_SECRET_KEY"] = LEGACY_KEY;
    process.env["STRIPE_SECRET_KEY_US"] = US_KEY;
    _resetStripeClientForTests();
    const uk = stripe("uk");
    const us = stripe("us");
    expect(uk).not.toBe(us);
    expect(stripe("uk")).toBe(uk);
    expect(stripe("us")).toBe(us);
  });

  it("defaults to the uk entity when called without an argument", () => {
    process.env["STRIPE_SECRET_KEY"] = LEGACY_KEY;
    _resetStripeClientForTests();
    expect(stripe()).toBe(stripe("uk"));
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
