// Unit tests for lib/regions/* — the country → {region, entity} mapping
// (spec invariant: total function, D1/D2) and the env-based database-URL
// resolution (EU alias fallback; US fails closed).

import { afterEach, describe, expect, it } from "vitest";

import { RegionNotConfiguredError, databaseUrlFor, regionEnabled } from "@/lib/regions/config";
import {
  DEFAULT_BILLING_ENTITY,
  DEFAULT_REGION,
  isBillingEntity,
  isRegion,
  regionForCountry,
  resolveSignupRegion,
} from "@/lib/regions/mapping";

const ENV_KEYS = ["DATABASE_URL", "DATABASE_URL_EU", "DATABASE_URL_US", "REGION_US_ENABLED"];
const original = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = original.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("regionForCountry()", () => {
  it("maps US to the US region + US entity", () => {
    expect(regionForCountry("US")).toEqual({ region: "us", entity: "us" });
  });

  it("normalises case and whitespace", () => {
    expect(regionForCountry("us")).toEqual({ region: "us", entity: "us" });
    expect(regionForCountry("  Us ")).toEqual({ region: "us", entity: "us" });
  });

  it("maps the UK and EU countries to EU region + UK entity", () => {
    for (const code of ["GB", "DE", "FR", "IE", "ES"]) {
      expect(regionForCountry(code)).toEqual({ region: "eu", entity: "uk" });
    }
  });

  it("maps rest-of-world to EU region + UK entity (decision D2)", () => {
    for (const code of ["AU", "NZ", "CA", "JP", "BR", "JE", "IM"]) {
      expect(regionForCountry(code)).toEqual({ region: "eu", entity: "uk" });
    }
  });

  it("is total: unknown or malformed input falls through to the default", () => {
    for (const input of ["", "USA", "U", "XX", "??", "united states"]) {
      expect(regionForCountry(input)).toEqual({
        region: DEFAULT_REGION,
        entity: DEFAULT_BILLING_ENTITY,
      });
    }
  });
});

describe("type guards", () => {
  it("isRegion accepts only eu/us", () => {
    expect(isRegion("eu")).toBe(true);
    expect(isRegion("us")).toBe(true);
    expect(isRegion("uk")).toBe(false);
    expect(isRegion("")).toBe(false);
  });

  it("isBillingEntity accepts only uk/us", () => {
    expect(isBillingEntity("uk")).toBe(true);
    expect(isBillingEntity("us")).toBe(true);
    expect(isBillingEntity("eu")).toBe(false);
  });
});

describe("databaseUrlFor()", () => {
  it("eu prefers DATABASE_URL_EU when set", () => {
    process.env["DATABASE_URL_EU"] = "postgresql://eu-explicit";
    process.env["DATABASE_URL"] = "postgresql://legacy";
    expect(databaseUrlFor("eu")).toBe("postgresql://eu-explicit");
  });

  it("eu falls back to the legacy DATABASE_URL (Phase 1 alias)", () => {
    delete process.env["DATABASE_URL_EU"];
    process.env["DATABASE_URL"] = "postgresql://legacy";
    expect(databaseUrlFor("eu")).toBe("postgresql://legacy");
  });

  it("defaults to the EU region when called without an argument", () => {
    delete process.env["DATABASE_URL_EU"];
    process.env["DATABASE_URL"] = "postgresql://legacy";
    expect(databaseUrlFor()).toBe("postgresql://legacy");
  });

  it("treats placeholder values as unset", () => {
    process.env["DATABASE_URL_EU"] =
      "postgresql://postgres.YOUR_PROJECT_REF:YOUR_DB_PASSWORD@example:5432/postgres";
    process.env["DATABASE_URL"] = "postgresql://legacy";
    expect(databaseUrlFor("eu")).toBe("postgresql://legacy");
  });

  it("eu throws when nothing is configured", () => {
    delete process.env["DATABASE_URL_EU"];
    delete process.env["DATABASE_URL"];
    expect(() => databaseUrlFor("eu")).toThrow(RegionNotConfiguredError);
  });

  it("us FAILS CLOSED when DATABASE_URL_US is unset — never falls back to EU", () => {
    delete process.env["DATABASE_URL_US"];
    process.env["DATABASE_URL"] = "postgresql://legacy";
    process.env["DATABASE_URL_EU"] = "postgresql://eu-explicit";
    expect(() => databaseUrlFor("us")).toThrow(RegionNotConfiguredError);
  });

  it("us resolves only from DATABASE_URL_US", () => {
    process.env["DATABASE_URL_US"] = "postgresql://us-project";
    expect(databaseUrlFor("us")).toBe("postgresql://us-project");
  });
});

describe("resolveSignupRegion() — the US launch-gate clamp (Phase 3)", () => {
  it("assigns US region + entity when the US gate is open", () => {
    expect(resolveSignupRegion("US", true)).toEqual({ region: "us", entity: "us" });
  });

  it("CLAMPS a US selection back to EU/UK when the gate is closed", () => {
    // Server-side fail-closed: a stale/tampered post must never create a
    // US-region org while regionEnabled("us") is false.
    expect(resolveSignupRegion("US", false)).toEqual({
      region: DEFAULT_REGION,
      entity: DEFAULT_BILLING_ENTITY,
    });
  });

  it("leaves non-US countries on EU/UK regardless of the gate", () => {
    for (const usEnabled of [true, false]) {
      for (const code of ["GB", "IE", "DE", "ZZ", "", "??"]) {
        expect(resolveSignupRegion(code, usEnabled)).toEqual({
          region: DEFAULT_REGION,
          entity: DEFAULT_BILLING_ENTITY,
        });
      }
    }
  });

  it("normalises case/whitespace like regionForCountry", () => {
    expect(resolveSignupRegion("  us ", true)).toEqual({ region: "us", entity: "us" });
    expect(resolveSignupRegion("  us ", false)).toEqual({
      region: DEFAULT_REGION,
      entity: DEFAULT_BILLING_ENTITY,
    });
  });
});

describe("regionEnabled()", () => {
  it("eu is always enabled (control plane)", () => {
    delete process.env["REGION_US_ENABLED"];
    expect(regionEnabled("eu")).toBe(true);
  });

  it("us requires BOTH the flag and a configured URL", () => {
    delete process.env["REGION_US_ENABLED"];
    delete process.env["DATABASE_URL_US"];
    expect(regionEnabled("us")).toBe(false);

    process.env["REGION_US_ENABLED"] = "true";
    expect(regionEnabled("us")).toBe(false);

    process.env["DATABASE_URL_US"] = "postgresql://us-project";
    delete process.env["REGION_US_ENABLED"];
    expect(regionEnabled("us")).toBe(false);

    process.env["REGION_US_ENABLED"] = "true";
    expect(regionEnabled("us")).toBe(true);
  });
});
