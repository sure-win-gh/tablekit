// Shared presentation helpers for billing/account surfaces.
//
// Plan labels, prices, the "still has access" status set, and money/date
// formatting live here so the billing page and the Settings → Account page
// render them identically. organisations.plan stays webhook-authoritative —
// these are display-only mappings keyed off it.

export const PLAN_LABEL: Record<string, string> = { free: "Free", core: "Core", plus: "Plus" };

export const PLAN_PRICE: Record<string, string> = {
  core: "£29/month + VAT",
  plus: "£74/month + VAT",
};

// Statuses where the org still has access (past_due keeps access during
// Stripe's dunning retries).
export const SUBSCRIBED = new Set(["active", "trialing", "past_due"]);

export function fmtMoney(pence: number): string {
  return `£${(pence / 100).toFixed(2)}`;
}

export function fmtDate(d: Date | null): string {
  if (!d) return "—";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}
