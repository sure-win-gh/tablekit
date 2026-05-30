// Prior-visit lookups for the seating-moment enrichment. "Prior" =
// realised visits strictly before this booking's start (cancelled +
// no-show don't count). Exposes a single-row API + a batch API so
// the bookings list page doesn't N+1.
//
// Org / venue scope is enforced by RLS at the connection level;
// these helpers don't have to filter on org_id themselves.

import "server-only";

import { and, eq, inArray, lt, ne, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { REALISED_STATUSES } from "@/lib/bookings/realised";
import { bookings } from "@/lib/db/schema";
import type * as schema from "@/lib/db/schema";

type Db = NodePgDatabase<typeof schema>;

export async function getPriorRealisedVisits(
  db: Db,
  args: { guestId: string; beforeStartAt: Date; excludeBookingId: string },
): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int`.as("n") })
    .from(bookings)
    .where(
      and(
        eq(bookings.guestId, args.guestId),
        inArray(bookings.status, [...REALISED_STATUSES]),
        lt(bookings.startAt, args.beforeStartAt),
        ne(bookings.id, args.excludeBookingId),
      ),
    );
  return row?.n ?? 0;
}

// Batched lookup for the bookings list / timeline / floor-plan
// surfaces. Returns a Map keyed by the *excluded* booking id (the
// booking being rendered) so callers can hydrate without thinking
// about guests with multiple rows in the same view.
export async function getPriorRealisedVisitsBatch(
  db: Db,
  items: Array<{ bookingId: string; guestId: string; startAt: Date }>,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (items.length === 0) return out;

  // One row per (guest_id, status, start_at) in REALISED. Counting
  // per-guest across the union of guests in the view is the smallest
  // useful query: each caller then filters "before this booking's
  // start" in memory against the typed-out rows. Keeps the SQL flat
  // and avoids a correlated subquery per row.
  const guestIds = Array.from(new Set(items.map((i) => i.guestId)));
  const rows = await db
    .select({
      guestId: bookings.guestId,
      bookingId: bookings.id,
      startAt: bookings.startAt,
    })
    .from(bookings)
    .where(
      and(inArray(bookings.guestId, guestIds), inArray(bookings.status, [...REALISED_STATUSES])),
    );

  const byGuest = new Map<string, Array<{ bookingId: string; startAt: Date }>>();
  for (const r of rows) {
    const list = byGuest.get(r.guestId) ?? [];
    list.push({ bookingId: r.bookingId, startAt: r.startAt });
    byGuest.set(r.guestId, list);
  }

  for (const item of items) {
    const list = byGuest.get(item.guestId) ?? [];
    let n = 0;
    for (const r of list) {
      if (r.bookingId === item.bookingId) continue;
      if (r.startAt < item.startAt) n++;
    }
    out.set(item.bookingId, n);
  }
  return out;
}

// Pure copy used by the badge + dialog so the labelling stays
// identical across surfaces. "Prior" is the count returned above;
// the displayed visit number is `prior + 1` (this booking counted).
export type VisitLabel = {
  text: string;
  tone: "info" | "success";
  // Total visit ordinal including this one (1 = first, 2 = second, ...).
  ordinal: number;
};

export function visitLabel(prior: number): VisitLabel {
  if (prior <= 0) return { text: "First visit", tone: "info", ordinal: 1 };
  if (prior === 1) return { text: "2nd visit", tone: "info", ordinal: 2 };
  return { text: `Regular · ${prior + 1} visits`, tone: "success", ordinal: prior + 1 };
}
