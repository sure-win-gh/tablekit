import { describe, expect, it } from "vitest";

import { lastNDays, todayUtc } from "@/lib/server/admin/dashboard/filter";

describe("admin filter — UTC bounds", () => {
  it("todayUtc anchors at 00:00:00 UTC", () => {
    const now = new Date("2026-04-27T13:14:15.678Z");
    const bounds = todayUtc(now);
    expect(bounds.fromUtc.toISOString()).toBe("2026-04-27T00:00:00.000Z");
    expect(bounds.toUtc.toISOString()).toBe("2026-04-27T13:14:15.678Z");
  });

  it("lastNDays(0) === todayUtc", () => {
    const now = new Date("2026-04-27T13:14:15.678Z");
    expect(lastNDays(0, now)).toEqual(todayUtc(now));
  });

  it("lastNDays(7) starts 7 calendar days back at 00:00 UTC", () => {
    const now = new Date("2026-04-27T13:14:15.678Z");
    const bounds = lastNDays(7, now);
    expect(bounds.fromUtc.toISOString()).toBe("2026-04-20T00:00:00.000Z");
    expect(bounds.toUtc).toEqual(now);
  });

  it("lastNDays(30) starts 30 calendar days back at 00:00 UTC", () => {
    const now = new Date("2026-04-27T13:14:15.678Z");
    const bounds = lastNDays(30, now);
    expect(bounds.fromUtc.toISOString()).toBe("2026-03-28T00:00:00.000Z");
  });
});
