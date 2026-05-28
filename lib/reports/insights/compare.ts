// Period comparison — the equal-length window immediately preceding the
// selected one, plus pure extractors for the headline metrics the
// comparison band shows.
//
// The insights surface uses a free from/to range rather than named
// periods, so "previous equivalent" is the contiguous window of identical
// duration ending exactly where the current one begins. Duration is
// computed from the UTC bounds, so a window spanning a DST change keeps
// its true elapsed length.

import type { Bounds } from "../types";
import type { LeadTimeRow, NoShowTrendDailyRow } from "./types";

export type ComparePeriod = {
  bounds: Bounds;
  // True when the current window runs up to or past `now` — its last day
  // is still in progress, so the comparison is "to date", not like-for-like.
  partial: boolean;
};

export function previousEquivalentBounds(bounds: Bounds, now: Date = new Date()): ComparePeriod {
  const lengthMs = bounds.endUtc.getTime() - bounds.startUtc.getTime();
  return {
    bounds: {
      startUtc: new Date(bounds.startUtc.getTime() - lengthMs),
      endUtc: new Date(bounds.startUtc.getTime()),
      timezone: bounds.timezone,
    },
    partial: bounds.endUtc.getTime() > now.getTime(),
  };
}

// Headline metrics, derived from the insight query outputs so the
// comparison band reuses the same data the cards already fetched.

export function totalBookings(rows: LeadTimeRow[]): number {
  return rows.reduce((sum, r) => sum + r.bookings, 0);
}

// Share of bookings that are same-day (0..1). 0 when there are none.
export function sameDayShare(rows: LeadTimeRow[]): number {
  const total = totalBookings(rows);
  if (total === 0) return 0;
  const sameDay = rows.find((r) => r.bucket === "same-day")?.bookings ?? 0;
  return sameDay / total;
}

// Overall no-show rate across the window (0..1). 0 when nothing eligible.
export function overallNoShowRate(rows: NoShowTrendDailyRow[]): number {
  let eligible = 0;
  let noShows = 0;
  for (const r of rows) {
    eligible += r.eligible;
    noShows += r.noShows;
  }
  return eligible === 0 ? 0 : noShows / eligible;
}
