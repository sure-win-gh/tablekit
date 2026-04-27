import { describe, expect, it } from "vitest";

import { __activityScore as activityScore } from "@/lib/server/admin/dashboard/metrics/venues-search";

describe("activity score", () => {
  it("zero on a totally idle org", () => {
    expect(activityScore(0, 0, 0)).toBe(0);
  });

  it("100 on an org saturated on all three components", () => {
    expect(activityScore(20, 5, 30)).toBe(100);
  });

  it("saturates each component at its threshold", () => {
    expect(activityScore(40, 10, 60)).toBe(100);
  });

  it("at-risk band: < 30 = a few bookings only", () => {
    // 5 bookings → 12.5 / 50, no logins, no messages → ~13
    const score = activityScore(5, 0, 0);
    expect(score).toBeLessThan(30);
    expect(score).toBeGreaterThan(0);
  });

  it("logins alone are capped at 20 points", () => {
    expect(activityScore(0, 100, 0)).toBe(20);
  });

  it("messages alone are capped at 30 points", () => {
    expect(activityScore(0, 0, 1000)).toBe(30);
  });
});
