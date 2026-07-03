// Server-side region config — env-only, never hardcoded.
//
// Alias pattern (docs/specs/multi-region.md, Phase 1): the EU URL reads
// DATABASE_URL_EU and falls back to the legacy DATABASE_URL so the
// existing deployment keeps working untouched; the US URL is unset until
// Phase 4 bring-up and FAILS CLOSED until then. A wrong-region lookup
// must never silently fall back to the other region's database.
//
// Placeholder values containing "YOUR_" are treated as unset — same
// defence as lib/stripe/client.ts (prevents a running-but-broken server).

import "server-only";

import { DEFAULT_REGION, type Region } from "./mapping";

export class RegionNotConfiguredError extends Error {
  constructor(region: Region, envName: string) {
    super(
      `lib/regions/config.ts: no database URL configured for region "${region}" — ` +
        `set ${envName}. See .env.local.example.`,
    );
    this.name = "RegionNotConfiguredError";
  }
}

function readUrl(name: string): string | null {
  const v = process.env[name];
  if (!v || v.includes("YOUR_")) return null;
  return v;
}

/**
 * Postgres connection string for a region's database.
 *
 *   eu → DATABASE_URL_EU, falling back to the legacy DATABASE_URL.
 *   us → DATABASE_URL_US only. No fallback — fails closed.
 */
export function databaseUrlFor(region: Region = DEFAULT_REGION): string {
  if (region === "eu") {
    const url = readUrl("DATABASE_URL_EU") ?? readUrl("DATABASE_URL");
    if (!url) throw new RegionNotConfiguredError("eu", "DATABASE_URL_EU (or DATABASE_URL)");
    return url;
  }
  const url = readUrl("DATABASE_URL_US");
  if (!url) throw new RegionNotConfiguredError("us", "DATABASE_URL_US");
  return url;
}

/**
 * Whether a region is available in this deployment. `eu` is always on
 * (it's the control plane); `us` requires BOTH the kill-switch-style
 * flag REGION_US_ENABLED="true" AND a configured DATABASE_URL_US.
 * Gated dark until the Phase 4 launch gates are green (US entity +
 * Stripe account, state sales-tax registrations).
 */
export function regionEnabled(region: Region): boolean {
  if (region === "eu") return true;
  return process.env["REGION_US_ENABLED"] === "true" && readUrl("DATABASE_URL_US") !== null;
}
