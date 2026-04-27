// Live Stripe MRR + sub mix for the founder's /admin/financials page.
//
// Why live-pull rather than mirror to a `subscriptions` table:
//   - we have no billing webhook plumbing yet;
//   - founder-only dashboard with limited traffic, latency is fine;
//   - the alternative phase (mirror billing state) is bigger than
//     this whole milestone — defer until we feel the pain.
//
// 5-minute in-memory cache. Module-scoped, so every Vercel instance
// has its own copy — fine for the founder's low-traffic surface.
// On Stripe API error we serve the last cached value with degraded
// = true so the page never crashes; if there's no prior cache, we
// return zeros + degraded.
//
// MRR computation: sum monthly-equivalent of every active subscription
// item, grouped by price.lookup_key for the tier breakdown. Yearly
// plans amortise as 1/12; weekly as ×4.345; daily as ×30.437.

import "server-only";

import { stripe, stripeEnabled } from "@/lib/stripe/client";

export type MrrSnapshot = {
  mrrMinor: number;
  byTier: Record<string, number>;
  activeSubs: number;
  asOf: Date;
  degraded: boolean;
  reason: "ok" | "stripe_not_configured" | "stripe_error";
};

const TTL_MS = 5 * 60 * 1000;
let cached: { data: MrrSnapshot; expiresAt: number } | null = null;

const INTERVALS_PER_MONTH: Record<string, number> = {
  day: 30.437,
  week: 4.345,
  month: 1,
  year: 1 / 12,
};

function toMonthlyMinor(unitMinor: number, interval: string, intervalCount: number): number {
  const factor = INTERVALS_PER_MONTH[interval] ?? 1;
  return Math.round((unitMinor * factor) / Math.max(intervalCount, 1));
}

async function fetchFromStripe(): Promise<MrrSnapshot> {
  let mrrMinor = 0;
  let activeSubs = 0;
  const byTier: Record<string, number> = {};

  for await (const sub of stripe().subscriptions.list({ status: "active", limit: 100 })) {
    activeSubs += 1;
    for (const item of sub.items.data) {
      const unit = item.price.unit_amount ?? 0;
      const recurring = item.price.recurring;
      const monthlyMinor = toMonthlyMinor(
        unit * (item.quantity ?? 1),
        recurring?.interval ?? "month",
        recurring?.interval_count ?? 1,
      );
      mrrMinor += monthlyMinor;
      const tier = item.price.lookup_key ?? item.price.nickname ?? "unknown";
      byTier[tier] = (byTier[tier] ?? 0) + monthlyMinor;
    }
  }

  return { mrrMinor, byTier, activeSubs, asOf: new Date(), degraded: false, reason: "ok" };
}

function emptySnapshot(reason: MrrSnapshot["reason"]): MrrSnapshot {
  return {
    mrrMinor: 0,
    byTier: {},
    activeSubs: 0,
    asOf: new Date(),
    degraded: true,
    reason,
  };
}

export async function getMrrSnapshot(): Promise<MrrSnapshot> {
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.data;

  if (!stripeEnabled()) {
    // Don't cache the not-configured state — flipping the env var
    // should take effect on the next request.
    return emptySnapshot("stripe_not_configured");
  }

  try {
    const data = await fetchFromStripe();
    cached = { data, expiresAt: now + TTL_MS };
    return data;
  } catch {
    if (cached) return { ...cached.data, degraded: true, reason: "stripe_error" };
    return emptySnapshot("stripe_error");
  }
}

// Test-only — reset the module-scoped cache between cases.
export function __resetMrrCache(): void {
  cached = null;
}
