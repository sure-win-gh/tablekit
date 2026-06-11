// Pure extractors for the headline metrics the comparison band shows.
// The previous-period window itself is resolved in ./ranges.ts (named
// ranges, time-aware so an incomplete period compares like-for-like).
//
// Headline metrics, derived from the insight query outputs so the
// comparison band reuses the same data the cards already fetched.

import type { LeadTimeRow, NoShowTrendDailyRow } from "./types";

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
