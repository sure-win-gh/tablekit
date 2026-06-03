// Unit coverage for the segment helpers (the SQL behaviour is covered by
// tests/integration/segments.test.ts).

import { describe, expect, it } from "vitest";

import { SEGMENTS, SEGMENT_LABEL, isSegment, segmentPredicate } from "@/lib/guests/segments";

describe("segment helpers", () => {
  it("isSegment guards the union", () => {
    expect(isSegment("regular")).toBe(true);
    expect(isSegment("vip")).toBe(true);
    expect(isSegment("nope")).toBe(false);
    expect(isSegment(null)).toBe(false);
    expect(isSegment(42)).toBe(false);
  });

  it("every segment has a label", () => {
    for (const s of SEGMENTS) {
      expect(SEGMENT_LABEL[s]).toBeTruthy();
    }
  });

  it("'all' adds no predicate; the others do", () => {
    const venue = "11111111-1111-1111-1111-111111111111";
    const now = new Date("2026-06-01T00:00:00Z");
    expect(segmentPredicate(venue, "all", now)).toBeUndefined();
    for (const s of ["new", "regular", "lapsed", "vip"] as const) {
      expect(segmentPredicate(venue, s, now)).toBeDefined();
    }
  });
});
