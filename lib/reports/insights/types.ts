// Shared types for the Booking Insights module. Sits alongside the
// MVP report types in ../types.ts but kept separate so the Plus-tier
// feature can be reasoned about (and tree-shaken) independently.

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
