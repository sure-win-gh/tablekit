// Shared loader for special-event closures (docs/specs/special-events.md).
//
// Published, blocking events overlapping a range, each carrying its area
// scope: `areaIds` null = the whole venue (zero junction rows — the default
// and every pre-2.5 event), otherwise the specific floor-plan areas the
// event closes. Also carries slug/name so the month calendar can deep-link
// event days without a second lookup.
//
// One implementation for all three closure consumers (single-day public
// availability, month availability, and the createBooking re-check) — they
// previously duplicated this query inline.

import "server-only";

import { and, eq, gt, inArray, lt } from "drizzle-orm";

import { specialEventAreas, specialEvents } from "@/lib/db/schema";
import { adminDb } from "@/lib/server/admin/db";

import type { ClosureWindow } from "./availability";

export type EventClosure = ClosureWindow & {
  eventId: string;
  slug: string;
  name: string;
};

export async function loadEventClosures(
  db: ReturnType<typeof adminDb>,
  venueId: string,
  rangeStartUtc: Date,
  rangeEndUtc: Date,
): Promise<EventClosure[]> {
  const rows = await db
    .select({
      id: specialEvents.id,
      slug: specialEvents.slug,
      name: specialEvents.name,
      startAt: specialEvents.startsAt,
      endAt: specialEvents.endsAt,
    })
    .from(specialEvents)
    .where(
      and(
        eq(specialEvents.venueId, venueId),
        eq(specialEvents.status, "published"),
        eq(specialEvents.blocksStandardBookings, true),
        lt(specialEvents.startsAt, rangeEndUtc),
        gt(specialEvents.endsAt, rangeStartUtc),
      ),
    );
  if (rows.length === 0) return [];

  const areaRows = await db
    .select({
      eventId: specialEventAreas.eventId,
      areaId: specialEventAreas.areaId,
    })
    .from(specialEventAreas)
    .where(
      inArray(
        specialEventAreas.eventId,
        rows.map((r) => r.id),
      ),
    );
  const areasByEvent = new Map<string, string[]>();
  for (const a of areaRows) {
    const list = areasByEvent.get(a.eventId) ?? [];
    list.push(a.areaId);
    areasByEvent.set(a.eventId, list);
  }

  return rows.map((r) => ({
    eventId: r.id,
    slug: r.slug,
    name: r.name,
    startAt: r.startAt,
    endAt: r.endAt,
    areaIds: areasByEvent.get(r.id) ?? null,
  }));
}

// True iff the closure blocks the whole venue (no area scope).
export function isWholeVenue(c: ClosureWindow): boolean {
  return !c.areaIds || c.areaIds.length === 0;
}
