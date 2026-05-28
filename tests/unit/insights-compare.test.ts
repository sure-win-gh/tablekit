import { describe, expect, it } from "vitest";

import type { Bounds } from "@/lib/reports/types";
import {
  overallNoShowRate,
  previousEquivalentBounds,
  sameDayShare,
  totalBookings,
} from "@/lib/reports/insights/compare";
import type { LeadTimeRow, NoShowTrendDailyRow } from "@/lib/reports/insights/types";

const bounds = (startIso: string, endIso: string): Bounds => ({
  startUtc: new Date(startIso),
  endUtc: new Date(endIso),
  timezone: "Europe/London",
});

describe("previousEquivalentBounds", () => {
  it("returns the contiguous window of identical duration ending where the current one starts", () => {
    // A 7-day window (London local days, no DST change here).
    const current = bounds("2026-05-11T00:00:00.000+01:00", "2026-05-18T00:00:00.000+01:00");
    const prev = previousEquivalentBounds(current, new Date("2026-05-18T12:00:00Z"));
    expect(prev.bounds.endUtc.getTime()).toBe(current.startUtc.getTime());
    expect(prev.bounds.endUtc.getTime() - prev.bounds.startUtc.getTime()).toBe(
      current.endUtc.getTime() - current.startUtc.getTime(),
    );
    expect(prev.bounds.timezone).toBe("Europe/London");
  });

  it("preserves true elapsed duration across a spring-forward DST boundary", () => {
    // UK clocks went forward 2026-03-29. A venue-local week straddling it is
    // 167 wall-clock hours; the bounds carry that true elapsed length, and the
    // previous window must mirror it exactly.
    const current = bounds("2026-03-26T00:00:00.000Z", "2026-04-02T00:00:00.000+01:00");
    const lengthMs = current.endUtc.getTime() - current.startUtc.getTime();
    const prev = previousEquivalentBounds(current, new Date("2026-04-02T12:00:00Z"));
    expect(prev.bounds.endUtc.getTime() - prev.bounds.startUtc.getTime()).toBe(lengthMs);
    expect(prev.bounds.endUtc.getTime()).toBe(current.startUtc.getTime());
  });

  it("flags partial when the current window extends to/past now", () => {
    const current = bounds("2026-05-01T00:00:00Z", "2026-05-31T00:00:00Z");
    // now is before the window end → the last day is still in progress.
    expect(previousEquivalentBounds(current, new Date("2026-05-20T09:00:00Z")).partial).toBe(true);
    // now is past the window end → it's a complete, like-for-like period.
    expect(previousEquivalentBounds(current, new Date("2026-06-05T09:00:00Z")).partial).toBe(false);
  });
});

describe("headline metric extractors", () => {
  const lead = (overrides: Partial<Record<LeadTimeRow["bucket"], number>>): LeadTimeRow[] =>
    (["same-day", "1d", "2-3d", "4-7d", "8-14d", "15-30d", "30d+"] as const).map((bucket) => ({
      bucket,
      bookings: overrides[bucket] ?? 0,
      covers: 0,
    }));

  it("totalBookings sums across buckets", () => {
    expect(totalBookings(lead({ "same-day": 3, "1d": 2, "30d+": 5 }))).toBe(10);
  });

  it("sameDayShare is the same-day fraction, 0 when empty", () => {
    expect(sameDayShare(lead({ "same-day": 3, "1d": 1 }))).toBeCloseTo(0.75, 5);
    expect(sameDayShare(lead({}))).toBe(0);
  });

  it("overallNoShowRate sums no-shows over eligible, 0 when nothing eligible", () => {
    const rows: NoShowTrendDailyRow[] = [
      { day: "2026-05-11", eligible: 4, noShows: 1, withDepositEligible: 1, withDepositNoShows: 0 },
      { day: "2026-05-12", eligible: 6, noShows: 1, withDepositEligible: 2, withDepositNoShows: 1 },
    ];
    expect(overallNoShowRate(rows)).toBeCloseTo(0.2, 5);
    expect(overallNoShowRate([])).toBe(0);
  });
});
