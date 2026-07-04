// venueCloseMinutes + staleSeatedCutoff — the pure venue-local time
// logic behind the auto-finish sweep.

import { describe, expect, it } from "vitest";

import { staleSeatedCutoff, venueCloseMinutes } from "@/lib/bookings/finish-sweep";

const svc = (days: string[], end: string) => ({ schedule: { days, start: "09:00", end } });

describe("venueCloseMinutes", () => {
  it("returns the latest end across services running that weekday", () => {
    const services = [svc(["mon", "tue"], "15:00"), svc(["mon", "fri"], "22:30")];
    expect(venueCloseMinutes(services, "mon")).toBe(22 * 60 + 30);
    expect(venueCloseMinutes(services, "tue")).toBe(15 * 60);
  });

  it("ignores services that don't run that day", () => {
    const services = [svc(["sat"], "23:00")];
    expect(venueCloseMinutes(services, "wed")).toBeNull();
  });

  it("returns null with no services at all", () => {
    expect(venueCloseMinutes([], "mon")).toBeNull();
  });

  it("tolerates malformed schedules", () => {
    const services = [
      { schedule: null },
      { schedule: { days: "mon", end: "22:00" } }, // days not an array
      { schedule: { days: ["mon"] } }, // no end
      svc(["mon"], "21:00"),
    ];
    expect(venueCloseMinutes(services, "mon")).toBe(21 * 60);
  });
});

describe("staleSeatedCutoff", () => {
  const TZ = "Europe/London";
  const everyday = (end: string) => [svc(["sun", "mon", "tue", "wed", "thu", "fri", "sat"], end)];
  // 2026-06-15 is a Monday; June = BST (UTC+1). Wall times below are
  // venue-local; the instants passed in are UTC.
  const startOfDayUtc = new Date("2026-06-14T23:00:00Z"); // 00:00 BST 15th

  it("before close: cutoff is start of the venue-day (yesterday only)", () => {
    // 20:00 wall, close 22:00 → grace window not reached.
    const now = new Date("2026-06-15T19:00:00Z");
    expect(staleSeatedCutoff(now, TZ, everyday("22:00")).getTime()).toBe(startOfDayUtc.getTime());
  });

  it("within the hour after close: still start of day (grace)", () => {
    // 22:30 wall, close 22:00 → inside the 60-min grace.
    const now = new Date("2026-06-15T21:30:00Z");
    expect(staleSeatedCutoff(now, TZ, everyday("22:00")).getTime()).toBe(startOfDayUtc.getTime());
  });

  it("past close + grace: cutoff is now (today's tables qualify)", () => {
    // 23:30 wall, close 22:00 → 90 min past close.
    const now = new Date("2026-06-15T22:30:00Z");
    expect(staleSeatedCutoff(now, TZ, everyday("22:00")).getTime()).toBe(now.getTime());
  });

  it("closed day / no services: cutoff is start of day", () => {
    const now = new Date("2026-06-15T22:30:00Z");
    expect(staleSeatedCutoff(now, TZ, []).getTime()).toBe(startOfDayUtc.getTime());
    // Service that doesn't run on Mondays.
    expect(staleSeatedCutoff(now, TZ, [svc(["sat"], "17:00")]).getTime()).toBe(
      startOfDayUtc.getTime(),
    );
  });

  it("close ≥ 23:00 can never reach the grace window same-day (documented limitation)", () => {
    // 23:59 wall on a 23:30-close venue — 23:30 + 60 > midnight.
    const now = new Date("2026-06-15T22:59:00Z");
    expect(staleSeatedCutoff(now, TZ, everyday("23:30")).getTime()).toBe(startOfDayUtc.getTime());
  });
});
