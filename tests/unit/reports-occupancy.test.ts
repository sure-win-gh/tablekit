// Pure calendar math behind the occupancy report — weekday occurrence
// counting over an inclusive venue-local date range.

import { describe, expect, it } from "vitest";

import { countWeekdayOccurrences } from "@/lib/reports/occupancy";

describe("countWeekdayOccurrences", () => {
  it("counts a two-day range (Mon–Tue)", () => {
    // 2026-05-11 is a Monday.
    const counts = countWeekdayOccurrences("2026-05-11", "2026-05-12");
    expect(counts).toEqual({ sun: 0, mon: 1, tue: 1, wed: 0, thu: 0, fri: 0, sat: 0 });
  });

  it("counts every weekday exactly once over a full week", () => {
    const counts = countWeekdayOccurrences("2026-05-11", "2026-05-17");
    expect(Object.values(counts)).toEqual([1, 1, 1, 1, 1, 1, 1]);
  });

  it("counts a full month with uneven weekday distribution", () => {
    // May 2026 starts on a Friday: Fri/Sat/Sun occur 5×, Mon–Thu 4×.
    const counts = countWeekdayOccurrences("2026-05-01", "2026-05-31");
    expect(counts).toEqual({ sun: 5, mon: 4, tue: 4, wed: 4, thu: 4, fri: 5, sat: 5 });
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(31);
  });

  it("handles a single-day range", () => {
    // 2026-07-02 is a Thursday.
    const counts = countWeekdayOccurrences("2026-07-02", "2026-07-02");
    expect(counts.thu).toBe(1);
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(1);
  });

  it("returns all zeros for an inverted range", () => {
    const counts = countWeekdayOccurrences("2026-05-12", "2026-05-11");
    expect(Object.values(counts).every((v) => v === 0)).toBe(true);
  });

  it("crosses a February leap boundary correctly", () => {
    // 2028 is a leap year; 2028-02-28 (Mon) → 2028-03-01 (Wed) = 3 days.
    const counts = countWeekdayOccurrences("2028-02-28", "2028-03-01");
    expect(counts).toEqual({ sun: 0, mon: 1, tue: 1, wed: 1, thu: 0, fri: 0, sat: 0 });
  });
});
