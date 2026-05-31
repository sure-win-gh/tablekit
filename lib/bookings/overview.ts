import type { BookingStatus } from "./state";

// Aggregates behind the bookings-page "Day overview" card. Kept here
// (not in the client card component) so the server page can compute
// them in the same pass it builds the rows, and both sides share one
// type. `covers` excludes cancelled / no-show — those seats aren't
// actually filled.
export type OverviewAgg = {
  total: number;
  covers: number;
  statusCounts: Partial<Record<BookingStatus, number>>;
  noTableCount: number;
};

// One toggle option in the card: the whole day ("All") or a single
// service. `key` is "all" or the service name; `label` is what the
// toggle shows.
export type OverviewSegment = OverviewAgg & {
  key: string;
  label: string;
};

export function emptyAgg(): OverviewAgg {
  return { total: 0, covers: 0, statusCounts: {}, noTableCount: 0 };
}

export function bumpAgg(
  agg: OverviewAgg,
  status: BookingStatus,
  partySize: number,
  noTable: boolean,
): void {
  agg.total += 1;
  agg.statusCounts[status] = (agg.statusCounts[status] ?? 0) + 1;
  if (status !== "cancelled" && status !== "no_show") agg.covers += partySize;
  if (noTable) agg.noTableCount += 1;
}
