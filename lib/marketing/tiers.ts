// The three plans, and the helper that drives the pricing matrix.
//
// A feature is tagged with the *minimum* tier it becomes available at
// (see features.ts). `tierIncludes` then expands that cumulatively: a
// "core" feature is included in Core *and* Plus. One source, no
// per-column hand-maintenance.

import { PRICING } from "./site";

export type Tier = "free" | "core" | "plus";

export const TIER_ORDER: Tier[] = ["free", "core", "plus"];

const RANK: Record<Tier, number> = { free: 0, core: 1, plus: 2 };

/** Does a plan at `planTier` include a feature whose minimum tier is `featureTier`? */
export function tierIncludes(planTier: Tier, featureTier: Tier): boolean {
  return RANK[planTier] >= RANK[featureTier];
}

export type PlanCopy = {
  tier: Tier;
  name: string;
  /** Monthly price, VAT-exclusive. null = the free plan. */
  pricePerMonth: number | null;
  /** One line of value, framed before the price. */
  blurb: string;
  /** What this tier adds, in plain words (answer-first, GEO-friendly). */
  headline: string;
  ctaLabel: string;
  /** Core is the recommended default — anchored visually on the pricing page. */
  recommended?: boolean;
};

export const PLANS: PlanCopy[] = [
  {
    tier: "free",
    name: "Free",
    pricePerMonth: 0,
    blurb: "Real online booking, free forever.",
    headline: `Take bookings from your own site and a shareable page — up to ${PRICING.freeBookingLimit} bookings a month, no card needed.`,
    ctaLabel: "Start free",
  },
  {
    tier: "core",
    name: "Core",
    pricePerMonth: 29,
    blurb: "Everything to run the floor and stop no-shows.",
    headline:
      "Unlimited bookings, deposits and no-show protection, SMS reminders, reviews and reporting.",
    ctaLabel: "Start free",
    recommended: true,
  },
  {
    tier: "plus",
    name: "Plus",
    pricePerMonth: 74,
    blurb: "For groups and busier venues.",
    headline:
      "Multiple venues, the AI enquiry handler, deeper insights and the public API — with priority support.",
    ctaLabel: "Start free",
  },
];

export function planByTier(tier: Tier): PlanCopy {
  const plan = PLANS.find((p) => p.tier === tier);
  if (!plan) throw new Error(`Unknown tier: ${tier}`);
  return plan;
}
