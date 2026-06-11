// Named insight ranges + their time-aware comparison windows.
//
// The insights surface picks a named period (this week / month / quarter
// / year, or a rolling last-7 / last-30 days). For each we resolve two
// UTC windows:
//
//   current  — start of the period (venue-local 00:00) up to *now*
//   previous — the same period shifted back ONE unit, truncated to the
//              same elapsed point (now − one unit, same wall-clock time)
//
// so an incomplete period compares like-for-like. On a Thursday, "this
// week" measures Mon 00:00→now against last Mon 00:00→last Thursday at
// the same time of day — not against a full prior week.
//
// All boundary maths happens in the venue's wall clock then converts to
// UTC via zonedWallToUtc, so DST shifts (BST↔GMT) keep the wall time
// stable. date-fns calendar helpers (subMonths/subYears) clamp month
// ends (e.g. 31 Mar − 1 month → 28/29 Feb).

import {
  format,
  parseISO,
  startOfMonth,
  startOfQuarter,
  startOfWeek,
  startOfYear,
  subDays,
  subMonths,
  subYears,
} from "date-fns";
import { formatInTimeZone } from "date-fns-tz";

import { todayInZone, zonedWallToUtc } from "@/lib/bookings/time";

import type { Bounds } from "../types";

export const RANGE_KEYS = ["last7", "last30", "week", "month", "quarter", "year"] as const;
export type RangeKey = (typeof RANGE_KEYS)[number];

export const RANGE_LABELS: Record<RangeKey, string> = {
  last7: "Last 7 days",
  last30: "Last 30 days",
  week: "This week",
  month: "This month",
  quarter: "This quarter",
  year: "This year",
};

export const DEFAULT_RANGE: RangeKey = "last30";

// Narrow an arbitrary query param into a known range, defaulting safely.
export function parseRange(raw: string | undefined): RangeKey {
  return RANGE_KEYS.includes(raw as RangeKey) ? (raw as RangeKey) : DEFAULT_RANGE;
}

type RangeSpec = {
  // Start of the current period from "today" (both plain dates).
  start: (d: Date) => Date;
  // Shift a date back by exactly one unit of this period.
  shift: (d: Date) => Date;
};

const SPECS: Record<RangeKey, RangeSpec> = {
  last7: { start: (d) => subDays(d, 6), shift: (d) => subDays(d, 7) },
  last30: { start: (d) => subDays(d, 29), shift: (d) => subDays(d, 30) },
  week: { start: (d) => startOfWeek(d, { weekStartsOn: 1 }), shift: (d) => subDays(d, 7) },
  month: { start: (d) => startOfMonth(d), shift: (d) => subMonths(d, 1) },
  quarter: { start: (d) => startOfQuarter(d), shift: (d) => subMonths(d, 3) },
  year: { start: (d) => startOfYear(d), shift: (d) => subYears(d, 1) },
};

const fmt = (d: Date): string => format(d, "yyyy-MM-dd");

export type ResolvedRange = {
  current: Bounds;
  previous: Bounds;
  fromDate: string; // current period start, YYYY-MM-DD venue-local
  toDate: string; // "now" date, YYYY-MM-DD venue-local
  label: string;
};

export function resolveRange(
  range: RangeKey,
  timezone: string,
  now: Date = new Date(),
): ResolvedRange {
  const spec = SPECS[range];
  const nowYmd = todayInZone(timezone, now);
  const nowHm = formatInTimeZone(now, timezone, "HH:mm");
  // `d` is the venue-local "today" as a plain calendar date — calendar
  // maths only, no time zone, mirrored back to a YMD string.
  const d = parseISO(nowYmd);

  const startYmd = fmt(spec.start(d));
  const prevStartYmd = fmt(spec.shift(parseISO(startYmd)));
  const prevEndYmd = fmt(spec.shift(d));

  const current: Bounds = {
    startUtc: zonedWallToUtc(startYmd, "00:00", timezone),
    endUtc: now,
    timezone,
  };
  const previous: Bounds = {
    startUtc: zonedWallToUtc(prevStartYmd, "00:00", timezone),
    endUtc: zonedWallToUtc(prevEndYmd, nowHm, timezone),
    timezone,
  };

  return { current, previous, fromDate: startYmd, toDate: nowYmd, label: RANGE_LABELS[range] };
}
