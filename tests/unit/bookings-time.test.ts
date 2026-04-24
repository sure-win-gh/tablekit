// Timezone helpers — small checks to make sure BST/GMT math is right.
// The availability engine relies on this being correct.

import { describe, expect, it } from "vitest";

import {
  dayKeyInZone,
  formatVenueTime,
  formatWallHHMM,
  parseWallHHMM,
  todayInZone,
  venueLocalDayRange,
  zonedWallToUtc,
} from "@/lib/bookings/time";

const LONDON = "Europe/London";

describe("zonedWallToUtc", () => {
  it("interprets a BST date (Apr) with UTC+1 offset", () => {
    const utc = zonedWallToUtc("2026-04-24", "12:00", LONDON);
    // London is BST (UTC+1) on 2026-04-24 → 12:00 local == 11:00 UTC.
    expect(utc.toISOString()).toBe("2026-04-24T11:00:00.000Z");
  });

  it("interprets a GMT date (Jan) with UTC+0 offset", () => {
    const utc = zonedWallToUtc("2026-01-10", "12:00", LONDON);
    expect(utc.toISOString()).toBe("2026-01-10T12:00:00.000Z");
  });
});

describe("venueLocalDayRange", () => {
  it("spans midnight to midnight in the venue zone (BST day)", () => {
    const { startUtc, endUtc } = venueLocalDayRange("2026-05-10", LONDON);
    // 2026-05-10 is BST. Local midnight = 23:00 UTC previous day.
    expect(startUtc.toISOString()).toBe("2026-05-09T23:00:00.000Z");
    expect(endUtc.toISOString()).toBe("2026-05-10T23:00:00.000Z");
  });
});

describe("dayKeyInZone", () => {
  it("returns the day-of-week in the venue's zone", () => {
    // 2026-05-10 is a Sunday.
    const utc = zonedWallToUtc("2026-05-10", "10:00", LONDON);
    expect(dayKeyInZone(utc, LONDON)).toBe("sun");
  });

  it("reads the zone clock, not UTC", () => {
    // 23:30 UTC on 2026-05-10 is 00:30 local on 2026-05-11 (BST).
    const utc = new Date("2026-05-10T23:30:00Z");
    expect(dayKeyInZone(utc, LONDON)).toBe("mon");
  });
});

describe("formatVenueTime", () => {
  it("formats UTC back to venue wall time", () => {
    const utc = new Date("2026-04-24T11:00:00Z");
    expect(formatVenueTime(utc, { timezone: LONDON })).toBe("12:00");
  });
});

describe("parseWallHHMM / formatWallHHMM round-trip", () => {
  it("round-trips", () => {
    for (const s of ["00:00", "09:15", "12:30", "23:45"]) {
      expect(formatWallHHMM(parseWallHHMM(s))).toBe(s);
    }
  });
});

describe("todayInZone", () => {
  it("yields YYYY-MM-DD in the supplied zone", () => {
    const fixed = new Date("2026-04-24T23:30:00Z");
    // 23:30 UTC on 2026-04-24 is 00:30 local on 2026-04-25 (BST).
    expect(todayInZone(LONDON, fixed)).toBe("2026-04-25");
  });
});
