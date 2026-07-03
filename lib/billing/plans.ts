// Plan ↔ Stripe Price mapping for the platform-account subscription,
// keyed by billing entity (docs/specs/multi-region.md, Phase 2).
//
// Products/Prices are created in each entity's Stripe dashboard (not via
// API) and their ids live in env — this module is the single source so the
// Checkout builder and the webhook reconciliation always agree on which
// price means which plan. See docs/specs/stripe-billing.md.
//
// Per entity, three prices:
//   uk: STRIPE_PRICE_CORE_UK  — flat £29/mo + VAT recurring (plan='core')
//       STRIPE_PRICE_PLUS_UK  — flat £74/mo + VAT recurring (plan='plus')
//       STRIPE_PRICE_USAGE_UK — metered price tied to the UK usage Meter
//       (each falls back to the legacy un-suffixed name — alias pattern)
//   us: STRIPE_PRICE_CORE_US / _PLUS_US / _USAGE_US — USD, price points
//       TBD; no fallback (fail closed until Phase 4 configures them).

import "server-only";

import type { Plan } from "@/lib/auth/plan-level";
import { DEFAULT_BILLING_ENTITY, type BillingEntity } from "@/lib/regions/mapping";

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

function readOptional(envName: string): string | null {
  const v = process.env[envName];
  if (!v || v.includes("YOUR_") || !v.startsWith("price_")) return null;
  return v;
}

// Env-name candidates for a price, per entity. uk falls back to the legacy
// un-suffixed names so the existing deployment keeps working untouched;
// us never falls back — a US price must never silently resolve to a GBP
// price on the UK account.
function candidates(base: "CORE" | "PLUS" | "USAGE", entity: BillingEntity): string[] {
  return entity === "uk"
    ? [`STRIPE_PRICE_${base}_UK`, `STRIPE_PRICE_${base}`]
    : [`STRIPE_PRICE_${base}_US`];
}

function resolvePrice(base: "CORE" | "PLUS" | "USAGE", entity: BillingEntity): string | null {
  for (const name of candidates(base, entity)) {
    const v = readOptional(name);
    if (v) return v;
  }
  return null;
}

// Flat recurring price id for a paid plan on an entity. Throws if
// unconfigured.
export function priceIdForPlan(
  plan: PaidPlan,
  entity: BillingEntity = DEFAULT_BILLING_ENTITY,
): string {
  const base = plan === "core" ? "CORE" : "PLUS";
  const v = resolvePrice(base, entity);
  if (!v) throw new BillingPriceNotConfiguredError(candidates(base, entity).join(" / "));
  return v;
}

// The metered usage price attached to every subscription (PR-3 reports
// against its Meter). Returns null when unconfigured so the subscription
// can still be sold before the usage Meter is set up — the usage line
// item is simply omitted until the price env is provided.
export function optionalUsagePriceId(
  entity: BillingEntity = DEFAULT_BILLING_ENTITY,
): string | null {
  return resolvePrice("USAGE", entity);
}

// Reverse map: given a Stripe price id seen on a subscription, which paid
// plan is it? Returns null for the usage price or any unknown id (so the
// caller can ignore non-plan line items). Reads env lazily and tolerates
// unconfigured prices (returns null rather than throwing) — the webhook
// must never 500 just because one price env is missing.
//
// Checks BOTH entities' configured prices: price_* ids are globally unique
// across Stripe accounts, so a match unambiguously identifies the plan
// regardless of which entity's webhook delivered the event.
export function planFromPriceId(priceId: string): PaidPlan | null {
  for (const entity of ["uk", "us"] as const) {
    if (resolvePrice("CORE", entity) === priceId) return "core";
    if (resolvePrice("PLUS", entity) === priceId) return "plus";
  }
  return null;
}
