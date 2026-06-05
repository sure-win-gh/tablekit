// Unit coverage for the pure reconciliation helpers in
// lib/billing/subscription.ts (status→plan mapping, plan-from-items,
// period-end extraction). The DB-writing syncFromSubscription itself is
// covered by tests/integration/billing-webhook.test.ts.

import type Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { deriveOrgPlan, periodEndOf, planFromSubscription } from "@/lib/billing/subscription";

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved["STRIPE_PRICE_CORE"] = process.env["STRIPE_PRICE_CORE"];
  saved["STRIPE_PRICE_PLUS"] = process.env["STRIPE_PRICE_PLUS"];
  process.env["STRIPE_PRICE_CORE"] = "price_core_123";
  process.env["STRIPE_PRICE_PLUS"] = "price_plus_456";
});
afterEach(() => {
  for (const k of ["STRIPE_PRICE_CORE", "STRIPE_PRICE_PLUS"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function sub(opts: { prices: string[]; periodEnd?: number }): Stripe.Subscription {
  return {
    items: {
      data: opts.prices.map((id, i) => ({
        price: { id },
        ...(i === 0 && opts.periodEnd ? { current_period_end: opts.periodEnd } : {}),
      })),
    },
  } as unknown as Stripe.Subscription;
}

describe("deriveOrgPlan", () => {
  it("grants the subscription's plan while active/trialing/past_due", () => {
    expect(deriveOrgPlan("active", "core")).toBe("core");
    expect(deriveOrgPlan("trialing", "plus")).toBe("plus");
    // past_due keeps access — Stripe is still dunning, don't revoke yet.
    expect(deriveOrgPlan("past_due", "plus")).toBe("plus");
  });

  it("drops to free on any terminal status", () => {
    expect(deriveOrgPlan("canceled", "plus")).toBe("free");
    expect(deriveOrgPlan("unpaid", "core")).toBe("free");
    expect(deriveOrgPlan("incomplete_expired", "core")).toBe("free");
  });

  it("leaves the plan untouched on recoverable in-between states", () => {
    // incomplete: initial payment not yet confirmed → no entitlement granted.
    expect(deriveOrgPlan("incomplete", "core")).toBeNull();
    // paused: recoverable (resumes via subscription.updated) → don't revoke.
    expect(deriveOrgPlan("paused", "plus")).toBeNull();
  });

  it("leaves the plan untouched if an entitled sub has no known plan price", () => {
    expect(deriveOrgPlan("active", null)).toBeNull();
  });
});

describe("planFromSubscription", () => {
  it("returns the first line item that maps to a plan, ignoring usage/unknown", () => {
    expect(planFromSubscription(sub({ prices: ["price_usage_789", "price_plus_456"] }))).toBe(
      "plus",
    );
    expect(planFromSubscription(sub({ prices: ["price_core_123"] }))).toBe("core");
  });

  it("returns null when no item maps to a plan", () => {
    expect(planFromSubscription(sub({ prices: ["price_usage_789"] }))).toBeNull();
    expect(planFromSubscription(sub({ prices: [] }))).toBeNull();
  });
});

describe("periodEndOf", () => {
  it("reads current_period_end off the first item (2025 Stripe API shape)", () => {
    const secs = Math.floor(Date.UTC(2026, 6, 1) / 1000);
    expect(periodEndOf(sub({ prices: ["price_core_123"], periodEnd: secs }))?.toISOString()).toBe(
      new Date(secs * 1000).toISOString(),
    );
  });

  it("returns null when absent", () => {
    expect(periodEndOf(sub({ prices: ["price_core_123"] }))).toBeNull();
  });
});
