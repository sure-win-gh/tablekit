// Unit coverage for the plan ↔ Stripe price mapping. Pure env-driven
// logic — no Stripe, no DB.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  BillingPriceNotConfiguredError,
  optionalUsagePriceId,
  planFromPriceId,
  priceIdForPlan,
} from "@/lib/billing/plans";

const ENV_KEYS = [
  "STRIPE_PRICE_CORE",
  "STRIPE_PRICE_PLUS",
  "STRIPE_PRICE_USAGE",
  "STRIPE_PRICE_CORE_UK",
  "STRIPE_PRICE_PLUS_UK",
  "STRIPE_PRICE_USAGE_UK",
  "STRIPE_PRICE_CORE_US",
  "STRIPE_PRICE_PLUS_US",
  "STRIPE_PRICE_USAGE_US",
] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  // Clean multi-entity slate; legacy cases run against un-suffixed names.
  for (const k of ENV_KEYS) delete process.env[k];
  process.env["STRIPE_PRICE_CORE"] = "price_core_123";
  process.env["STRIPE_PRICE_PLUS"] = "price_plus_456";
  process.env["STRIPE_PRICE_USAGE"] = "price_usage_789";
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("priceIdForPlan", () => {
  it("maps each paid plan to its configured price id", () => {
    expect(priceIdForPlan("core")).toBe("price_core_123");
    expect(priceIdForPlan("plus")).toBe("price_plus_456");
  });

  it("throws when the price env is missing or a placeholder", () => {
    delete process.env["STRIPE_PRICE_CORE"];
    expect(() => priceIdForPlan("core")).toThrow(BillingPriceNotConfiguredError);
    process.env["STRIPE_PRICE_PLUS"] = "price_YOUR_PLUS_PRICE_ID";
    expect(() => priceIdForPlan("plus")).toThrow(BillingPriceNotConfiguredError);
  });
});

describe("planFromPriceId", () => {
  it("round-trips the configured price ids back to plans", () => {
    expect(planFromPriceId("price_core_123")).toBe("core");
    expect(planFromPriceId("price_plus_456")).toBe("plus");
  });

  it("returns null for the usage price or any unknown id", () => {
    expect(planFromPriceId("price_usage_789")).toBeNull();
    expect(planFromPriceId("price_nonsense")).toBeNull();
  });

  it("never throws when a plan env is unset (webhook must not 500)", () => {
    delete process.env["STRIPE_PRICE_CORE"];
    expect(planFromPriceId("price_plus_456")).toBe("plus");
    expect(planFromPriceId("price_core_123")).toBeNull();
  });
});

describe("entity keying (multi-region Phase 2)", () => {
  it("uk prefers the _UK-suffixed env over the legacy name", () => {
    process.env["STRIPE_PRICE_CORE_UK"] = "price_core_uk_111";
    expect(priceIdForPlan("core", "uk")).toBe("price_core_uk_111");
    // Legacy name still resolves for the un-suffixed plans (fallback).
    expect(priceIdForPlan("plus", "uk")).toBe("price_plus_456");
  });

  it("defaults to the uk entity when called without one", () => {
    expect(priceIdForPlan("core")).toBe("price_core_123");
    expect(optionalUsagePriceId()).toBe("price_usage_789");
  });

  it("us FAILS CLOSED — never falls back to legacy/UK prices", () => {
    expect(() => priceIdForPlan("core", "us")).toThrow(BillingPriceNotConfiguredError);
    expect(optionalUsagePriceId("us")).toBeNull();
    process.env["STRIPE_PRICE_CORE_US"] = "price_core_us_999";
    expect(priceIdForPlan("core", "us")).toBe("price_core_us_999");
  });

  it("planFromPriceId recognises prices from BOTH entities", () => {
    process.env["STRIPE_PRICE_CORE_US"] = "price_core_us_999";
    process.env["STRIPE_PRICE_PLUS_US"] = "price_plus_us_888";
    expect(planFromPriceId("price_core_us_999")).toBe("core");
    expect(planFromPriceId("price_plus_us_888")).toBe("plus");
    // UK/legacy prices keep resolving too.
    expect(planFromPriceId("price_core_123")).toBe("core");
  });
});

describe("optionalUsagePriceId", () => {
  it("returns the id when configured, null when placeholder/unset", () => {
    expect(optionalUsagePriceId()).toBe("price_usage_789");
    process.env["STRIPE_PRICE_USAGE"] = "price_YOUR_USAGE_PRICE_ID";
    expect(optionalUsagePriceId()).toBeNull();
    delete process.env["STRIPE_PRICE_USAGE"];
    expect(optionalUsagePriceId()).toBeNull();
  });
});
