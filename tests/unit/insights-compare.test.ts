import { describe, expect, it } from "vitest";

import { overallNoShowRate, sameDayShare, totalBookings } from "@/lib/reports/insights/compare";
import type { LeadTimeRow, NoShowTrendDailyRow } from "@/lib/reports/insights/types";

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
