// Marketing-email allowance + overage pricing — the commercial constants
// and the pure costing function shared by reserve, reconcile, and the UI.
//
// Pure (no DB, no server-only) so the client composer/tab hints and the
// server billing paths import the same numbers — mirroring the
// entitlements.ts pattern. See docs/specs/email-broadcast-billing.md.
//
// Commercials (agreed 2026-07-07):
//   - Core includes 500 marketing emails / calendar month, Plus 2,500.
//   - Overage: Core £1.00 / Plus £0.90 per 1,000, ex-VAT, drawn from the
//     prepaid credit balance, rounded UP to the whole penny per campaign.
//   - Cost basis: Resend ~$0.80/1,000 ≈ £0.60 → 40%/33% gross margin.
//     Review quarterly against FX + the Resend rate card.
//   - VAT is collected at credit top-up (Stripe Tax) — never here.

import type { Plan } from "@/lib/auth/plan-level";

export const MARKETING_EMAIL = {
  allowancePerMonth: { free: 0, core: 500, plus: 2500 },
  overagePencePer1000: { free: 0, core: 100, plus: 90 },
} as const satisfies Record<string, Record<Plan, number>>;

// INVARIANT (mirrors lib/billing/credit.ts): the campaign reserve and the
// reconcile refund MUST both cost email sends through this one function,
// each against the SAME snapshot inputs (allowance remaining + rate
// captured at reserve time) — otherwise refunds drift. Changing the
// formula means changing reserve + reconcile together.
export function emailCampaignCostPence(
  count: number,
  allowanceRemaining: number,
  pencePer1000: number,
): number {
  const chargeable = Math.max(0, Math.floor(count) - Math.max(0, Math.floor(allowanceRemaining)));
  return Math.ceil((chargeable * Math.max(0, pencePer1000)) / 1000);
}

// How many of `count` sends fall outside the remaining allowance —
// split out for the composer's "X within allowance · Y chargeable" line.
export function emailChargeableCount(count: number, allowanceRemaining: number): number {
  return Math.max(0, Math.floor(count) - Math.max(0, Math.floor(allowanceRemaining)));
}

// UTC calendar-month bounds for a moment in time. Matches billingPeriod's
// 'yyyy-mm' framing in lib/billing/usage.ts — allowances reset when the
// usage period does.
export function monthBoundsUtc(now: Date): { start: Date; end: Date } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end };
}
