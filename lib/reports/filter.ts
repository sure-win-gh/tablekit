// Filter validation + venue-local → UTC bounds.
//
// Every report query takes a `Bounds` (UTC instants) rather than the
// raw filter so the conversion is unit-testable in one place.
// `parseFilter` does the YYYY-MM-DD shape check; the timezone is
// trusted as already-validated upstream (it comes from venues.timezone).

import { venueLocalDayRange } from "@/lib/bookings/time";

import type { Bounds, ReportFilter } from "./types";

const YMD = /^\d{4}-\d{2}-\d{2}$/;

export type FilterParseResult =
  | { ok: true; filter: ReportFilter; bounds: Bounds }
  | { ok: false; reason: "bad-date" | "range-inverted" };

export function parseFilter(input: ReportFilter): FilterParseResult {
  if (!YMD.test(input.fromDate) || !YMD.test(input.toDate)) {
    return { ok: false, reason: "bad-date" };
  }
  if (input.fromDate > input.toDate) {
    return { ok: false, reason: "range-inverted" };
  }

  const start = venueLocalDayRange(input.fromDate, input.timezone).startUtc;
  // toDate is inclusive — bounds end at the *start* of the day after
  // toDate, in venue-local zone.
  const end = venueLocalDayRange(input.toDate, input.timezone).endUtc;

  return {
    ok: true,
    filter: input,
    bounds: { startUtc: start, endUtc: end, timezone: input.timezone },
  };
}
