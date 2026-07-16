// Regression tests for the signup FormData → schema mapping.
//
// The bug this locks: the `country` field was added to the schema and the
// form, but never read from FormData in the action — so the selected country
// was silently discarded and every org resolved to eu/uk regardless of the
// pick. That is a latent data-residency bug (once REGION_US_ENABLED flips, a
// US signup would land in the EU project with nothing flagging it). These
// tests exercise the real form field names and prove `country` round-trips,
// then compose the parser with resolveSignupRegion the way the action does.

import { describe, expect, it } from "vitest";

import { parseSignupForm } from "@/app/(marketing)/signup/parse";
import { DEFAULT_SIGNUP_COUNTRY, resolveSignupRegion } from "@/lib/regions/mapping";

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

const VALID = {
  email: "owner@example.com",
  password: "correct horse battery",
  full_name: "Sam Owner",
  org_name: "The Corner Café",
};

describe("parseSignupForm", () => {
  it("reads the country field (the field that was being dropped)", () => {
    const r = parseSignupForm(form({ ...VALID, country: "US" }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.country).toBe("US");
  });

  it("maps the snake_case form names onto the camelCase schema", () => {
    const r = parseSignupForm(form({ ...VALID, country: "GB" }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.fullName).toBe("Sam Owner");
      expect(r.data.orgName).toBe("The Corner Café");
      expect(r.data.email).toBe("owner@example.com");
    }
  });

  it("accepts a missing country as null, not a parse failure (no-JS post)", () => {
    // formData.get() returns null for an absent field; the schema is
    // `.nullish()` so this parses (the action then defaults it to GB).
    const r = parseSignupForm(form(VALID));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.country).toBeNull();
  });

  it("fails with field errors on a too-short password", () => {
    const r = parseSignupForm(form({ ...VALID, password: "short" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.fieldErrors["password"]?.length).toBeGreaterThan(0);
  });
});

describe("parse → resolveSignupRegion (the action's composition)", () => {
  function regionFor(country: string | null, usEnabled: boolean) {
    const fd = country === null ? form(VALID) : form({ ...VALID, country });
    const r = parseSignupForm(fd);
    if (!r.ok) throw new Error("valid fixture failed to parse");
    return resolveSignupRegion(r.data.country ?? DEFAULT_SIGNUP_COUNTRY, usEnabled);
  }

  it("a US pick with the gate OPEN creates a US-region org", () => {
    expect(regionFor("US", true)).toEqual({ region: "us", entity: "us" });
  });

  it("a US pick with the gate CLOSED is clamped to eu/uk", () => {
    expect(regionFor("US", false)).toEqual({ region: "eu", entity: "uk" });
  });

  it("a GB pick resolves to eu/uk regardless of the gate", () => {
    expect(regionFor("GB", true)).toEqual({ region: "eu", entity: "uk" });
    expect(regionFor("GB", false)).toEqual({ region: "eu", entity: "uk" });
  });

  it("a missing country defaults to GB → eu/uk", () => {
    expect(regionFor(null, true)).toEqual({ region: "eu", entity: "uk" });
  });
});
