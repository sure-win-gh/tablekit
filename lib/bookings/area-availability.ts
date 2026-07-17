// Operator area availability → ClosureWindows
// (docs/specs/area-preferences.md).
//
// Two per-area controls compile into the same area-scoped ClosureWindow
// list that special-event closures use, so findSlots needs no new concepts:
//
//   • bookable = false  — ad-hoc kill switch (weather). Closed every queried
//     day until the operator reopens it.
//   • closed_months     — venue-local months (1–12) the area is seasonally
//     shut ("winter" = {11,12,1,2,3}).
//
// Pure — the caller supplies the venue-local day list (ymd + UTC bounds,
// exactly what venueLocalDayRange produces), so this stays unit-testable
// and timezone maths lives in one place. These windows must NEVER feed the
// calendar's `events` map — an unavailable area is not an event.

import type { ClosureWindow } from "./availability";

export type AreaAvailabilitySpec = {
  id: string;
  bookable: boolean;
  closedMonths: number[];
};

export type LocalDay = {
  ymd: string; // YYYY-MM-DD, venue-local
  startUtc: Date;
  endUtc: Date;
};

export function areaAvailabilityClosures(
  areas: AreaAvailabilitySpec[],
  days: LocalDay[],
): ClosureWindow[] {
  const out: ClosureWindow[] = [];
  // Skip entirely-open areas up front — the common case stays O(days·0).
  const restricted = areas.filter((a) => !a.bookable || a.closedMonths.length > 0);
  if (restricted.length === 0) return out;

  for (const day of days) {
    const month = Number(day.ymd.slice(5, 7));
    for (const area of restricted) {
      if (!area.bookable || area.closedMonths.includes(month)) {
        out.push({ startAt: day.startUtc, endAt: day.endUtc, areaIds: [area.id] });
      }
    }
  }
  return out;
}
