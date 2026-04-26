// Filter parser — pure tests for the YYYY-MM-DD → UTC bounds path.
// The harder timezone math is already covered by bookings-time.test.ts;
// these checks pin the inclusive/exclusive semantics of the date range.

import { describe, expect, it } from "vitest";

import { parseFilter } from "@/lib/reports/filter";

const LONDON = "Europe/London";

describe("parseFilter", () => {
  it("makes endUtc the start of the day after toDate (inclusive range)", () => {
    const r = parseFilter({
      venueId: "v",
      fromDate: "2026-04-01",
      toDate: "2026-04-30",
      timezone: LONDON,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // April 2026 is BST (UTC+1). 1st 00:00 BST = 30 March 23:00 UTC.
    expect(r.bounds.startUtc.toISOString()).toBe("2026-03-31T23:00:00.000Z");
    // 30th 24:00 BST = 1 May 00:00 BST = 30 April 23:00 UTC.
    expect(r.bounds.endUtc.toISOString()).toBe("2026-04-30T23:00:00.000Z");
  });

  it("rejects malformed dates", () => {
    expect(
      parseFilter({ venueId: "v", fromDate: "26-04-01", toDate: "2026-04-30", timezone: LONDON }),
    ).toEqual({ ok: false, reason: "bad-date" });
    expect(
      parseFilter({ venueId: "v", fromDate: "2026-04-01", toDate: "rubbish", timezone: LONDON }),
    ).toEqual({ ok: false, reason: "bad-date" });
  });

  it("rejects an inverted range", () => {
    expect(
      parseFilter({ venueId: "v", fromDate: "2026-04-30", toDate: "2026-04-01", timezone: LONDON }),
    ).toEqual({ ok: false, reason: "range-inverted" });
  });

  it("permits a single-day range (from === to)", () => {
    const r = parseFilter({
      venueId: "v",
      fromDate: "2026-04-15",
      toDate: "2026-04-15",
      timezone: LONDON,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 24-hour bounds.
    expect(r.bounds.endUtc.getTime() - r.bounds.startUtc.getTime()).toBe(24 * 60 * 60 * 1000);
  });
});
