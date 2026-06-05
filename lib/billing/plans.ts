// Plan ↔ Stripe Price mapping for the platform-account subscription.
//
// Products/Prices are created in the Stripe dashboard (not via API) and
// their ids live in env — this module is the single source so the
// Checkout builder and the webhook reconciliation always agree on which
// price means which plan. See docs/specs/stripe-billing.md.
//
// Three prices:
//   STRIPE_PRICE_CORE   — flat £19/mo recurring (plan='core')
//   STRIPE_PRICE_PLUS   — flat £39/mo recurring (plan='plus')
//   STRIPE_PRICE_USAGE  — metered price tied to the usage Meter, attached
//                         to every paid subscription so transactional
//                         sends can be reported against it (PR-3).

import "server-only";

import type { Plan } from "@/lib/auth/plan-level";

// The paid plans this billing flow sells. 'free' has no price — it's the
// absence of (or a cancelled) subscription.
export type PaidPlan = Exclude<Plan, "free">;

export class BillingPriceNotConfiguredError extends Error {
  constructor(which: string) {
    super(
      `lib/billing/plans.ts: ${which} is not set (or is a placeholder). See .env.local.example.`,
    );
    this.name = "BillingPriceNotConfiguredError";
  }
}

function readPrice(envName: string): string {
  const v = process.env[envName];
  if (!v || v.includes("YOUR_") || !v.startsWith("price_")) {
    throw new BillingPriceNotConfiguredError(envName);
  }
  return v;
}

// Flat recurring price id for a paid plan. Throws if unconfigured.
export function priceIdForPlan(plan: PaidPlan): string {
  return readPrice(plan === "core" ? "STRIPE_PRICE_CORE" : "STRIPE_PRICE_PLUS");
}

// The metered usage price attached to every subscription (PR-3 reports
// against its Meter). Returns null when unconfigured so the subscription
// can still be sold before the usage Meter is set up — the usage line
// item is simply omitted until STRIPE_PRICE_USAGE is provided.
export function optionalUsagePriceId(): string | null {
  const v = process.env["STRIPE_PRICE_USAGE"];
  if (!v || v.includes("YOUR_") || !v.startsWith("price_")) return null;
  return v;
}

// Reverse map: given a Stripe price id seen on a subscription, which paid
// plan is it? Returns null for the usage price or any unknown id (so the
// caller can ignore non-plan line items). Reads env lazily and tolerates
// unconfigured prices (returns null rather than throwing) — the webhook
// must never 500 just because one price env is missing.
export function planFromPriceId(priceId: string): PaidPlan | null {
  const core = process.env["STRIPE_PRICE_CORE"];
  const plus = process.env["STRIPE_PRICE_PLUS"];
  if (core && priceId === core) return "core";
  if (plus && priceId === plus) return "plus";
  return null;
}
