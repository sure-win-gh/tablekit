// Multi-region vocabulary + the country → {region, entity} decision.
//
// CLIENT-SAFE — no env access, no secrets. The server-side env accessors
// (DB URLs etc.) live in lib/regions/config.ts, which is server-only.
// Split mirrors lib/billing/topup-amounts.ts: the signup form (Phase 3)
// needs this mapping in a Client Component for the country selector.
//
// See docs/specs/multi-region.md. Locked decisions:
//   D1 — the SELECTED country decides; geo headers only pre-select.
//   D2 — everything non-US → UK entity / EU region (Australia included).
//   D7 — set once at signup, per-organisation, effectively immutable.

/** Where an organisation's data lives (Supabase project). */
export type Region = "eu" | "us";

/** Which legal entity the organisation contracts with (Stripe account). */
export type BillingEntity = "uk" | "us";

export const REGIONS = ["eu", "us"] as const satisfies readonly Region[];
export const BILLING_ENTITIES = ["uk", "us"] as const satisfies readonly BillingEntity[];

// Every org that predates multi-region — and every code path that has no
// org in scope yet — resolves here. Matches the column defaults pinned in
// migration 0053.
export const DEFAULT_REGION: Region = "eu";
export const DEFAULT_BILLING_ENTITY: BillingEntity = "uk";

export type RegionAssignment = {
  region: Region;
  entity: BillingEntity;
};

/**
 * The one place a customer's country becomes a region + billing entity.
 *
 * Total over all inputs (spec invariant): `"US"` (any case, surrounding
 * whitespace tolerated) → US region + US entity; every other string —
 * including unknown or malformed codes — falls through to EU/UK per D2.
 * Callers pass the ISO 3166-1 alpha-2 code the customer SELECTED at
 * signup, never a geo-IP guess (D1).
 */
export function regionForCountry(countryIso2: string): RegionAssignment {
  const normalised = countryIso2.trim().toUpperCase();
  if (normalised === "US") {
    return { region: "us", entity: "us" };
  }
  return { region: DEFAULT_REGION, entity: DEFAULT_BILLING_ENTITY };
}

export function isRegion(value: string): value is Region {
  return (REGIONS as readonly string[]).includes(value);
}

export function isBillingEntity(value: string): value is BillingEntity {
  return (BILLING_ENTITIES as readonly string[]).includes(value);
}
