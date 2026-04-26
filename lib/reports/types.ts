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
