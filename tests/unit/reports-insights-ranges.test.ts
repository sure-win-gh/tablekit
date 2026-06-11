import { formatInTimeZone } from "date-fns-tz";
import { describe, expect, it } from "vitest";

import { parseRange, resolveRange } from "@/lib/reports/insights/ranges";

const TZ = "Europe/London";
const wall = (d: Date) => formatInTimeZone(d, TZ, "yyyy-MM-dd HH:mm");
const DAY = 86_400_000;

describe("parseRange", () => {
  it("accepts known keys and defaults the rest to last30", () => {
    expect(parseRange("week")).toBe("week");
    expect(parseRange("year")).toBe("year");
    expect(parseRange(undefined)).toBe("last30");
    expect(parseRange("nonsense")).toBe("last30");
  });
});

describe("resolveRange — this week, mid-week (GMT)", () => {
  // 2026-01-15 is a Thursday; January is GMT (London = UTC+0).
  const now = new Date("2026-01-15T14:30:00Z");
  const r = resolveRange("week", TZ, now);

  it("current runs from Monday 00:00 to now", () => {
    expect(wall(r.current.startUtc)).toBe("2026-01-12 00:00");
    expect(r.current.endUtc.getTime()).toBe(now.getTime());
    expect(r.fromDate).toBe("2026-01-12");
    expect(r.toDate).toBe("2026-01-15");
  });

  it("previous is last week truncated to the same point — last Thursday 14:30", () => {
    expect(wall(r.previous.startUtc)).toBe("2026-01-05 00:00");
    expect(wall(r.previous.endUtc)).toBe("2026-01-08 14:30");
    // In GMT both bounds are exactly 7 days back.
    expect(r.previous.startUtc.getTime()).toBe(r.current.startUtc.getTime() - 7 * DAY);
    expect(r.previous.endUtc.getTime()).toBe(now.getTime() - 7 * DAY);
  });
});

describe("resolveRange — rolling windows", () => {
  const now = new Date("2026-01-15T14:30:00Z");

  it("last7 = 7 calendar days to now, vs the 7 before", () => {
    const r = resolveRange("last7", TZ, now);
    expect(wall(r.current.startUtc)).toBe("2026-01-09 00:00"); // today − 6
    expect(wall(r.previous.startUtc)).toBe("2026-01-02 00:00"); // − 7 more
    expect(wall(r.previous.endUtc)).toBe("2026-01-08 14:30"); // now − 7d
  });

  it("last30 = 30 calendar days to now, vs the 30 before", () => {
    const r = resolveRange("last30", TZ, now);
    expect(wall(r.current.startUtc)).toBe("2025-12-17 00:00"); // today − 29
    expect(wall(r.previous.startUtc)).toBe("2025-11-17 00:00"); // − 30 more
    expect(wall(r.previous.endUtc)).toBe("2025-12-16 14:30"); // now − 30d
  });
});

describe("resolveRange — month / quarter / year shifts", () => {
  const now = new Date("2026-05-20T09:00:00Z"); // BST in May (London = UTC+1) → local 10:00

  it("month shifts back one calendar month", () => {
    const r = resolveRange("month", TZ, now);
    expect(wall(r.current.startUtc)).toBe("2026-05-01 00:00");
    expect(wall(r.previous.startUtc)).toBe("2026-04-01 00:00");
    expect(wall(r.previous.endUtc)).toBe("2026-04-20 10:00");
  });

  it("quarter shifts back three calendar months", () => {
    const r = resolveRange("quarter", TZ, now);
    expect(wall(r.current.startUtc)).toBe("2026-04-01 00:00"); // Q2 starts April
    expect(wall(r.previous.startUtc)).toBe("2026-01-01 00:00");
    expect(wall(r.previous.endUtc)).toBe("2026-02-20 10:00");
  });

  it("year shifts back one calendar year", () => {
    const r = resolveRange("year", TZ, now);
    expect(wall(r.current.startUtc)).toBe("2026-01-01 00:00");
    expect(wall(r.previous.startUtc)).toBe("2025-01-01 00:00");
    expect(wall(r.previous.endUtc)).toBe("2025-05-20 10:00");
  });
});

describe("resolveRange — month-end clamping", () => {
  // 2026-03-31 is BST (clocks went forward 2026-03-29) → local 13:00.
  const now = new Date("2026-03-31T12:00:00Z");
  it("31 Mar − 1 month clamps to 28 Feb, same wall time", () => {
    const r = resolveRange("month", TZ, now);
    expect(wall(r.previous.endUtc)).toBe("2026-02-28 13:00");
  });
});

describe("resolveRange — DST boundary keeps wall time stable", () => {
  // 2026-10-29 (Thu) is GMT; one week back (2026-10-22) is still BST,
  // since the clocks change 2026-10-25. The previous window must keep
  // the same wall time even though the raw offset is 7d + 1h.
  const now = new Date("2026-10-29T12:00:00Z"); // local 12:00 GMT
  it("previous end stays at 12:00 wall, not exactly −7d", () => {
    const r = resolveRange("week", TZ, now);
    expect(formatInTimeZone(r.previous.endUtc, TZ, "HH:mm")).toBe("12:00");
    expect(r.previous.endUtc.getTime()).not.toBe(now.getTime() - 7 * DAY);
    expect(now.getTime() - r.previous.endUtc.getTime()).toBe(7 * DAY + 3_600_000);
  });
});
