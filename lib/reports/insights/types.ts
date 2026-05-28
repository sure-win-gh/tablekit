// Shared types for the Booking Insights module. Sits alongside the
// MVP report types in ../types.ts but kept separate so the Plus-tier
// feature can be reasoned about (and tree-shaken) independently.

// Granularity is a client-side rollup choice for the no-show evolution
// chart. The query always returns daily rows; the chart aggregates them
// up to the selected period in the browser, so toggling never re-queries.
export type Granularity = "day" | "week" | "month" | "year";

export const GRANULARITIES: ReadonlyArray<Granularity> = ["day", "week", "month", "year"];

// The known booking channels. Kept as a closed list so channel
// performance can show an explicit zero row for a channel that produced
// nothing in range, rather than silently omitting it.
export const BOOKING_SOURCES = ["host", "widget", "walk-in", "rwg", "api"] as const;

// Seven buckets covering the realistic spread of how far in advance
// people book a table: same-day walk-throughs at one end, "booked a
// month ago for the anniversary" at the other. The 30d+ tail is open
// so a 60-day-ahead Christmas booking still has a home.
export type LeadTimeBucket = "same-day" | "1d" | "2-3d" | "4-7d" | "8-14d" | "15-30d" | "30d+";

export const LEAD_TIME_BUCKETS: ReadonlyArray<LeadTimeBucket> = [
  "same-day",
  "1d",
  "2-3d",
  "4-7d",
  "8-14d",
  "15-30d",
  "30d+",
];

export type LeadTimeRow = {
  bucket: LeadTimeBucket;
  bookings: number;
  covers: number; // sum of party_size in the bucket
};

// One row per venue-local day. The no-show evolution chart rolls these
// up to week/month/year client-side. `eligible` = bookings the operator
// showed up for (confirmed/seated/finished/no_show); the withDeposit
// pair is the subset that had a succeeded deposit/hold payment.
export type NoShowTrendDailyRow = {
  day: string; // YYYY-MM-DD venue-local
  eligible: number;
  noShows: number;
  withDepositEligible: number;
  withDepositNoShows: number;
};

// Per-channel performance for the date range. `depositCaptureRate` is
// null (not 0) when the channel had no deposit-bound bookings — "no
// deposits taken" reads differently from "deposits taken, none captured".
export type ChannelPerformanceRow = {
  source: string;
  bookings: number;
  noShowRate: number;
  cancellationRate: number;
  avgPartySize: number;
  avgLeadTimeDays: number;
  depositCaptureRate: number | null;
};
