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

/**
 * The settlement currency each entity bills in: UK entity → GBP,
 * US entity → USD. Single source — replaces the hardcoded "gbp" that
 * used to live in lib/billing/topup.ts.
 */
export function currencyForEntity(entity: BillingEntity): "gbp" | "usd" {
  return entity === "us" ? "usd" : "gbp";
}

/**
 * Region/entity for a signup, honouring the US launch gate (Phase 3).
 *
 * `regionForCountry` says where a country *would* live; this clamps a US
 * selection back to EU/UK whenever the US region is not yet open
 * (`usEnabled === false`, i.e. `regionEnabled("us")`). It is the
 * server-side defence behind the form hiding the US option: a closed gate
 * must never create a US-region org, whatever a tampered or stale form
 * posts. Pre-launch this clamp is also D3-correct — a US business that
 * signs up today gets the UK contract until US bring-up (Phase 4).
 *
 * Pure and client-safe (no env): the caller passes `regionEnabled("us")`.
 */
export function resolveSignupRegion(countryIso2: string, usEnabled: boolean): RegionAssignment {
  const assignment = regionForCountry(countryIso2);
  if (assignment.region === "us" && !usEnabled) {
    return { region: DEFAULT_REGION, entity: DEFAULT_BILLING_ENTITY };
  }
  return assignment;
}

/** A country option shown in the signup selector (D1). */
export type SignupCountry = { code: string; label: string };

/**
 * Curated signup country options. Only a US selection changes the
 * region/entity (`regionForCountry`); every other option resolves to
 * EU/UK per D2, so "Other" is a genuine catch-all, not a gap. The US
 * row is filtered out of the form until `regionEnabled("us")` (Phase 4).
 * `ISO` codes are what the selector posts; `ZZ` is the sentinel for
 * "rest of world" and, being non-US, falls through to EU/UK.
 */
export const SIGNUP_COUNTRIES: readonly SignupCountry[] = [
  { code: "GB", label: "United Kingdom" },
  { code: "US", label: "United States" },
  { code: "ZZ", label: "Other (rest of world)" },
];

/** Default signup country. Used when geo pre-selection finds no match. */
export const DEFAULT_SIGNUP_COUNTRY = "GB";

export function isRegion(value: string): value is Region {
  return (REGIONS as readonly string[]).includes(value);
}

export function isBillingEntity(value: string): value is BillingEntity {
  return (BILLING_ENTITIES as readonly string[]).includes(value);
}

/**
 * Fail-closed narrowing for values read from the database. The column is
 * CHECK-constrained to 'uk'|'us', so this is unreachable today — but if a
 * third entity value ever lands before the code catches up, billing paths
 * must THROW rather than silently charge through the UK account.
 */
export function assertBillingEntity(value: string): BillingEntity {
  if (!isBillingEntity(value)) {
    throw new Error(`unknown billing entity "${value}" — expected one of: uk, us`);
  }
  return value;
}
