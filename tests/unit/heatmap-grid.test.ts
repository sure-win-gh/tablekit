import { describe, expect, it } from "vitest";

import { daysInMonth, heatBucket, monthGridDays, weekDays } from "@/lib/services/calendar";

describe("daysInMonth", () => {
  it("handles month lengths including leap February", () => {
    expect(daysInMonth(2026, 1)).toBe(31);
    expect(daysInMonth(2026, 2)).toBe(28); // 2026 not a leap year
    expect(daysInMonth(2024, 2)).toBe(29); // 2024 is
    expect(daysInMonth(2026, 4)).toBe(30);
  });
});

describe("monthGridDays", () => {
  it("lays out May 2026 (1st is a Friday) Monday-start with 4 leading blanks", () => {
    const weeks = monthGridDays("2026-05-15"); // day-of-month ignored
    // Fri = Monday-index 4 → 4 leading nulls.
    expect(weeks[0]!.slice(0, 4)).toEqual([null, null, null, null]);
    expect(weeks[0]![4]).toBe("2026-05-01");
    // 4 blanks + 31 days = 35 = exactly 5 full weeks.
    expect(weeks).toHaveLength(5);
    expect(weeks.every((w) => w.length === 7)).toBe(true);
    // Last real day present, trailing fully padded.
    expect(weeks.flat()).toContain("2026-05-31");
  });

  it("pads the final partial week to 7 with trailing nulls", () => {
    // Feb 2026: 1st is a Sunday (Monday-index 6) → 6 leading nulls + 28 days
    // = 34 cells → 5 weeks (35) with one trailing null.
    const weeks = monthGridDays("2026-02-01");
    expect(weeks[0]!.slice(0, 6)).toEqual([null, null, null, null, null, null]);
    expect(weeks[0]![6]).toBe("2026-02-01");
    expect(weeks).toHaveLength(5);
    expect(weeks.at(-1)!.at(-1)).toBeNull();
  });
});

describe("weekDays", () => {
  it("returns the Monday-start week containing the date", () => {
    // 2026-05-15 is a Friday → week runs Mon 11th … Sun 17th.
    expect(weekDays("2026-05-15")).toEqual([
      "2026-05-11",
      "2026-05-12",
      "2026-05-13",
      "2026-05-14",
      "2026-05-15",
      "2026-05-16",
      "2026-05-17",
    ]);
  });

  it("crosses a month boundary correctly", () => {
    // 2026-06-01 is a Monday → it's the start of its own week.
    expect(weekDays("2026-06-01")[0]).toBe("2026-06-01");
    // 2026-05-31 is a Sunday → week starts the previous Monday in May.
    expect(weekDays("2026-05-31")[0]).toBe("2026-05-25");
  });
});

describe("heatBucket", () => {
  it("maps utilisation to buckets at the 70/95% thresholds", () => {
    expect(heatBucket(0)).toBe("empty");
    expect(heatBucket(0.69)).toBe("low");
    expect(heatBucket(0.7)).toBe("mid");
    expect(heatBucket(0.94)).toBe("mid");
    expect(heatBucket(0.95)).toBe("high");
    expect(heatBucket(1.3)).toBe("high"); // overbooked is still high
  });
});
