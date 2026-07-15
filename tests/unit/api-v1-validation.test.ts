// Shared v1 validation primitives (lib/api/v1/validation.ts).
//
// The bar for these is bug-compatibility with the hand-rolled checks
// they replaced — the permissive UUID regex (not RFC-strict) and
// parseInt semantics for query-string numbers are deliberate.

import { describe, expect, it } from "vitest";

import { zIsoDate, zPartySize, zPartySizeParam, zUuid } from "@/lib/api/v1/validation";

describe("zUuid", () => {
  it("accepts a lowercase uuid", () => {
    expect(zUuid.safeParse("123e4567-e89b-12d3-a456-426614174000").success).toBe(true);
  });

  it("accepts uppercase (the original regex was case-insensitive)", () => {
    expect(zUuid.safeParse("123E4567-E89B-12D3-A456-426614174000").success).toBe(true);
  });

  it("accepts the all-zero uuid (permissive, no version bits)", () => {
    expect(zUuid.safeParse("00000000-0000-0000-0000-000000000000").success).toBe(true);
  });

  it("rejects junk, missing hyphens, and null", () => {
    expect(zUuid.safeParse("not-a-uuid").success).toBe(false);
    expect(zUuid.safeParse("123e4567e89b12d3a456426614174000").success).toBe(false);
    expect(zUuid.safeParse(null).success).toBe(false);
  });
});

describe("zIsoDate", () => {
  it("accepts yyyy-mm-dd", () => {
    expect(zIsoDate.safeParse("2026-06-15").success).toBe(true);
  });

  it("rejects other shapes", () => {
    expect(zIsoDate.safeParse("tomorrow").success).toBe(false);
    expect(zIsoDate.safeParse("15/06/2026").success).toBe(false);
    expect(zIsoDate.safeParse("2026-6-15").success).toBe(false);
    expect(zIsoDate.safeParse(null).success).toBe(false);
  });
});

describe("zPartySize", () => {
  it("accepts integers 1-20", () => {
    expect(zPartySize.safeParse(1).success).toBe(true);
    expect(zPartySize.safeParse(20).success).toBe(true);
  });

  it("rejects 0, 21, and non-integers", () => {
    expect(zPartySize.safeParse(0).success).toBe(false);
    expect(zPartySize.safeParse(21).success).toBe(false);
    expect(zPartySize.safeParse(2.5).success).toBe(false);
  });
});

describe("zPartySizeParam", () => {
  it("parses a numeric string", () => {
    const r = zPartySizeParam.safeParse("4");
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toBe(4);
  });

  it("keeps parseInt semantics: '5abc' parses to 5", () => {
    const r = zPartySizeParam.safeParse("5abc");
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toBe(5);
  });

  it("rejects out-of-range, garbage, empty, and null", () => {
    expect(zPartySizeParam.safeParse("999").success).toBe(false);
    expect(zPartySizeParam.safeParse("abc").success).toBe(false);
    expect(zPartySizeParam.safeParse("").success).toBe(false);
    expect(zPartySizeParam.safeParse(null).success).toBe(false);
  });
});
