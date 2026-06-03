// Guest engagement report (Phase 4) — segment sizes + aggregate campaign
// engagement for the insights surface.
//
// Segment sizes are a current snapshot of the guest base (not
// range-dependent). Campaign engagement is aggregated from the campaign
// counts tallies for campaigns created in the range.

import "server-only";

import { and, eq, gte, lt, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { campaigns } from "@/lib/db/schema";
import type * as schema from "@/lib/db/schema";
import { SEGMENT_LABEL, SEGMENTS, segmentSizes, type Segment } from "@/lib/guests/segments";

import type { Bounds } from "./types";

type Db = NodePgDatabase<typeof schema>;

export type SegmentSize = { key: Segment; label: string; count: number };

export type GuestEngagementReport = {
  segments: SegmentSize[];
  campaigns: {
    count: number;
    sent: number;
    opened: number;
    clicked: number;
    openRate: number; // 0..1 of sent
    clickRate: number;
  };
};

export async function getGuestEngagementReport(
  db: Db,
  organisationId: string,
  venueId: string,
  bounds: Bounds,
  now: Date,
): Promise<GuestEngagementReport> {
  const sizes = await segmentSizes(db, organisationId, venueId, now);
  const segments: SegmentSize[] = SEGMENTS.map((key) => ({
    key,
    label: SEGMENT_LABEL[key],
    count: sizes[key],
  }));

  // Aggregate the campaign counts tallies for campaigns created in range.
  const [agg] = await db
    .select({
      count: sql<number>`count(*)::int`,
      sent: sql<number>`coalesce(sum((${campaigns.counts}->>'sent')::int), 0)::int`,
      opened: sql<number>`coalesce(sum((${campaigns.counts}->>'opened')::int), 0)::int`,
      clicked: sql<number>`coalesce(sum((${campaigns.counts}->>'clicked')::int), 0)::int`,
    })
    .from(campaigns)
    .where(
      and(
        eq(campaigns.venueId, venueId),
        // Open/click only exist for email (Resend), so scope the rate
        // denominator to email — SMS/WhatsApp sends would otherwise
        // dilute the open/click rate.
        eq(campaigns.channel, "email"),
        gte(campaigns.createdAt, bounds.startUtc),
        lt(campaigns.createdAt, bounds.endUtc),
      ),
    );

  const sent = agg?.sent ?? 0;
  const opened = agg?.opened ?? 0;
  const clicked = agg?.clicked ?? 0;
  return {
    segments,
    campaigns: {
      count: agg?.count ?? 0,
      sent,
      opened,
      clicked,
      openRate: sent > 0 ? opened / sent : 0,
      clickRate: sent > 0 ? clicked / sent : 0,
    },
  };
}
