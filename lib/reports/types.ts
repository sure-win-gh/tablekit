// Shared types for the reporting module.
//
// `ReportFilter` is the contract every report query takes: a venue,
// a venue-local date range, and the venue's IANA zone. The two date
// strings are inclusive at both ends in the venue's local clock — so
// "2026-04-01 → 2026-04-30" covers the whole of April for that venue,
// regardless of where the server is.
//
// `Bounds` is the UTC-instant pair derived from a filter; the queries
// take this directly so the timezone math stays in `filter.ts`.

export type ReportFilter = {
  venueId: string;
  fromDate: string; // YYYY-MM-DD, inclusive, venue-local
  toDate: string; // YYYY-MM-DD, inclusive, venue-local
  timezone: string; // IANA, e.g. "Europe/London"
};

export type Bounds = {
  startUtc: Date; // inclusive
  endUtc: Date; // exclusive (covers the whole of toDate)
  timezone: string;
};

export type CoversRow = {
  day: string; // YYYY-MM-DD in venue zone
  serviceId: string;
  serviceName: string;
  bookings: number;
  coversBooked: number; // sum of party_size, all statuses
  coversRealised: number; // sum of party_size, confirmed|seated|finished
};

export type NoShowSummary = {
  // Overall (across all services in range).
  totalEligible: number; // confirmed|seated|finished|no_show
  totalNoShows: number;
  rate: number; // 0..1; 0 when totalEligible === 0
  withDepositEligible: number;
  withDepositNoShows: number;
  withDepositRate: number;
  // Per-service breakdown so operators can spot a problem service.
  byService: Array<{
    serviceId: string;
    serviceName: string;
    eligible: number;
    noShows: number;
    rate: number;
  }>;
};

export type DepositRevenueRow = {
  day: string; // YYYY-MM-DD in venue zone
  // All amounts are minor units (pence). Positive numbers; refunded is
  // reported separately rather than as a negative on revenue so the UI
  // can show gross/net side-by-side.
  depositsCollectedMinor: number;
  noShowCapturedMinor: number;
  refundedMinor: number;
  // Net = collected + captured − refunded. Same currency assumption as
  // the rest of the system (single currency per organisation today).
  netMinor: number;
};

export type SourceMixRow = {
  source: string;
  bookings: number;
  covers: number;
};

export type TopGuestRow = {
  guestId: string;
  firstName: string;
  visits: number; // confirmed|seated|finished only
  lastVisit: Date;
};

export type CancellationsReport = {
  totalBookings: number; // every booking created for a slot in range
  cancelled: number;
  rate: number; // 0..1; 0 when totalBookings === 0
  byDay: Array<{ day: string; bookings: number; cancelled: number }>;
  // Normalised reason strings; null reasons reported as "unspecified".
  byReason: Array<{ reason: string; count: number }>;
};

export type PeakTimeCell = {
  weekday: number; // ISO: 1=Mon .. 7=Sun, venue-local
  hour: number; // 0..23, venue-local
  bookings: number;
  covers: number; // realised statuses only
};

export type OccupancyRow = {
  serviceId: string;
  serviceName: string;
  sessionsInRange: number; // scheduled occurrences of the service in range
  capacityPerSession: number; // override ?? whole-room capacity
  totalCapacity: number; // sessionsInRange × capacityPerSession
  coversRealised: number;
  utilisation: number; // 0..n; 0 when totalCapacity === 0
};

export type ReviewsReport = {
  count: number;
  avgRating: number | null; // null when count === 0
  byDay: Array<{ day: string; count: number; avgRating: number }>;
  bySource: Array<{ source: string; count: number; avgRating: number }>;
  sentiment: { positive: number; neutral: number; negative: number; unclassified: number };
};

export type SpendReport = {
  orders: number;
  revenueMinor: number;
  covers: number; // sum of known cover counts (nullable at source)
  avgPerOrderMinor: number; // 0 when no orders
  // Spend per cover computed only over orders where the till reported a
  // cover count — null when none did, so the UI can say "unknown" rather
  // than implying £0.
  avgPerCoverMinor: number | null;
  byDay: Array<{ day: string; orders: number; revenueMinor: number }>;
};
