// Timeline block geometry — pure column maths for the timeline grid.
//
// Extracted from the timeline page so the branching (past-midnight
// rollover, window clamping, truncation flag) is unit-testable:
// tests/unit/timeline-span.test.ts.

import { formatInTimeZone } from "date-fns-tz";

export type TimelineWindow = { startHour: number; endHour: number };

export type TimelineSpan = {
  startCol: number; // 0-indexed slot (caller offsets for label columns)
  span: number; // 15-min slots, ≥1
  // True when the booking runs past the window's right edge — either
  // it ends later the same day than the window shows, or it rolls
  // past midnight (which always overruns the day view, even when the
  // window ends at 24:00).
  truncatedEnd: boolean;
};

export function bookingSpan(
  startAt: Date,
  endAt: Date,
  timezone: string,
  window: TimelineWindow,
): TimelineSpan | null {
  const startMin =
    Number(formatInTimeZone(startAt, timezone, "H")) * 60 +
    Number(formatInTimeZone(startAt, timezone, "m"));
  let endMin =
    Number(formatInTimeZone(endAt, timezone, "H")) * 60 +
    Number(formatInTimeZone(endAt, timezone, "m"));
  // Past-midnight rollover: reduced to same-day wall minutes, the end
  // reads strictly before the start (23:00–01:00 → 1380 vs 60). Treat
  // it as running to the end of the day and flag the truncation
  // unconditionally — clamping to 24:00 alone would hide the flag for
  // windows that end exactly at 24. Strict `<`: a zero-length booking
  // is degenerate data, not a rollover, and stays hidden below.
  const rolledPastMidnight = endMin < startMin;
  if (rolledPastMidnight) endMin = 24 * 60;
  const winStartMin = window.startHour * 60;
  const winEndMin = window.endHour * 60;
  const clampedStart = Math.max(startMin, winStartMin);
  const clampedEnd = Math.min(endMin, winEndMin);
  if (clampedEnd <= clampedStart) return null;
  const startCol = Math.floor((clampedStart - winStartMin) / 15);
  const endCol = Math.ceil((clampedEnd - winStartMin) / 15);
  return {
    startCol,
    span: Math.max(1, endCol - startCol),
    truncatedEnd: rolledPastMidnight || endMin > winEndMin,
  };
}
