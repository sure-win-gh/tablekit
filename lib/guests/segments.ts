// Built-in guest segments (Phase 4).
//
// Each segment compiles to a SQL predicate on a `guests` row, derived
// from venue-scoped realised-booking history + operator tags — data we
// already hold, no special-category profiling. Used two ways:
//   1. Insights: count guests per segment (segmentSizes).
//   2. Campaigns: narrow the consent-gated audience (and-composed in
//      lib/campaigns/recipients.ts).
//
// Saved operator-defined segments are out of scope for v1.

import "server-only";

import { sql, type SQL } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { REALISED_STATUSES } from "@/lib/bookings/realised";
import { guests } from "@/lib/db/schema";
import type * as schema from "@/lib/db/schema";

type Db = NodePgDatabase<typeof schema>;

export const SEGMENTS = ["all", "new", "regular", "lapsed", "vip"] as const;
export type Segment = (typeof SEGMENTS)[number];

export function isSegment(s: unknown): s is Segment {
  return typeof s === "string" && (SEGMENTS as readonly string[]).includes(s);
}

export const SEGMENT_LABEL: Record<Segment, string> = {
  all: "All guests",
  new: "New (1 visit)",
  regular: "Regulars (3+ visits)",
  lapsed: "Lapsed (90+ days)",
  vip: "VIP (tagged)",
};

// Default parameters — kept here as the single source.
const LAPSED_DAYS = 90;
const REGULAR_MIN_VISITS = 3;

// Realised-visit filter inside the bookings subqueries. Built from the
// shared REALISED_STATUSES constant so the segment definitions can't
// drift from the rest of reporting.
const REALISED = sql`status in (${sql.join(
  REALISED_STATUSES.map((s) => sql`${s}`),
  sql`, `,
)})`;

// SQL predicate (on the outer guests row) selecting the segment at a
// venue, or undefined for `all` (no narrowing). `now` is injectable so
// the lapsed window is deterministic in tests.
export function segmentPredicate(venueId: string, segment: Segment, now: Date): SQL | undefined {
  switch (segment) {
    case "all":
      return undefined;
    case "new":
      return sql`${guests.id} in (
        select guest_id from bookings
        where venue_id = ${venueId}::uuid and ${REALISED}
        group by guest_id having count(*) = 1)`;
    case "regular":
      return sql`${guests.id} in (
        select guest_id from bookings
        where venue_id = ${venueId}::uuid and ${REALISED}
        group by guest_id having count(*) >= ${REGULAR_MIN_VISITS})`;
    case "lapsed":
      return sql`${guests.id} in (
        select guest_id from bookings
        where venue_id = ${venueId}::uuid and ${REALISED}
        group by guest_id
        having max(start_at) < ${now}::timestamptz - make_interval(days => ${LAPSED_DAYS}))`;
    case "vip":
      return sql`exists (
        select 1 from unnest(${guests.tags}) as t(tag) where lower(t.tag) = 'vip')`;
  }
}

// Count of org guests in each segment at a venue (insights panel).
export async function segmentSizes(
  db: Db,
  organisationId: string,
  venueId: string,
  now: Date,
): Promise<Record<Segment, number>> {
  const p = (s: Segment) => segmentPredicate(venueId, s, now)!;
  const result = (await db.execute(sql`
    select
      count(*)::int as "all",
      count(*) filter (where ${p("new")})::int as "new",
      count(*) filter (where ${p("regular")})::int as "regular",
      count(*) filter (where ${p("lapsed")})::int as "lapsed",
      count(*) filter (where ${p("vip")})::int as "vip"
    from guests
    where organisation_id = ${organisationId}::uuid and erased_at is null
  `)) as unknown as { rows?: Record<Segment, number>[] } | Record<Segment, number>[];
  const rows = Array.isArray(result) ? result : (result.rows ?? []);
  const r = rows[0];
  return {
    all: r?.all ?? 0,
    new: r?.new ?? 0,
    regular: r?.regular ?? 0,
    lapsed: r?.lapsed ?? 0,
    vip: r?.vip ?? 0,
  };
}
