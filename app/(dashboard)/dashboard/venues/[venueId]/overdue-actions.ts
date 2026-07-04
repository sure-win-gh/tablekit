"use server";

// Server actions behind the overdue-table prompt (any venue dashboard
// screen — mounted in the venue layout). See docs/specs/service-flow.md.
//
// pollOverdueSeated doubles as the near-real-time auto-finish path:
// every poll first runs the venue-scoped sweep, so an open dashboard
// keeps its own floor tidy without waiting for the nightly cron.

import { and, asc, eq, inArray, lt } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireRole } from "@/lib/auth/require-role";
import { sweepVenueStaleSeated } from "@/lib/bookings/finish-sweep";
import { resizeBookingDuration } from "@/lib/bookings/resize";
import { formatVenueTime } from "@/lib/bookings/time";
import { transitionBooking } from "@/lib/bookings/transition";
import { bookingTables, bookings, guests, venueTables, venues } from "@/lib/db/schema";
import { adminDb } from "@/lib/server/admin/db";

const VenueArg = z.object({ venueId: z.uuid() });
const BookingArg = z.object({ venueId: z.uuid(), bookingId: z.uuid() });
const ExtendArg = z.object({
  venueId: z.uuid(),
  bookingId: z.uuid(),
  minutes: z.number().int().min(5).max(120),
});

export type OverdueSeatedRow = {
  bookingId: string;
  guestFirstName: string;
  partySize: number;
  tableLabels: string[];
  endWall: string; // venue-local HH:mm the booking was due to end
  overdueMinutes: number;
};

export type PollOverdueResult = { ok: false } | { ok: true; overdue: OverdueSeatedRow[] };

async function venueInOrg(venueId: string, orgId: string) {
  const [venue] = await adminDb()
    .select({
      id: venues.id,
      organisationId: venues.organisationId,
      timezone: venues.timezone,
      settings: venues.settings,
    })
    .from(venues)
    .where(and(eq(venues.id, venueId), eq(venues.organisationId, orgId)))
    .limit(1);
  return venue ?? null;
}

export async function pollOverdueSeated(raw: unknown): Promise<PollOverdueResult> {
  const parsed = VenueArg.safeParse(raw);
  if (!parsed.success) return { ok: false };
  const { orgId } = await requireRole("host");
  const venue = await venueInOrg(parsed.data.venueId, orgId);
  if (!venue) return { ok: false };

  // Inline auto-finish first — anything past close is tidied before we
  // decide what's "overdue but plausibly still sat".
  await sweepVenueStaleSeated(venue.id);

  const now = new Date();
  const db = adminDb();
  const rows = await db
    .select({
      id: bookings.id,
      endAt: bookings.endAt,
      partySize: bookings.partySize,
      guestFirstName: guests.firstName,
    })
    .from(bookings)
    .innerJoin(guests, eq(guests.id, bookings.guestId))
    .where(
      and(eq(bookings.venueId, venue.id), eq(bookings.status, "seated"), lt(bookings.endAt, now)),
    )
    .orderBy(asc(bookings.endAt));
  if (rows.length === 0) return { ok: true, overdue: [] };

  const tableRows = await db
    .select({ bookingId: bookingTables.bookingId, label: venueTables.label })
    .from(bookingTables)
    .innerJoin(venueTables, eq(venueTables.id, bookingTables.tableId))
    .where(
      inArray(
        bookingTables.bookingId,
        rows.map((r) => r.id),
      ),
    );
  const labelsByBooking = new Map<string, string[]>();
  for (const t of tableRows) {
    const list = labelsByBooking.get(t.bookingId) ?? [];
    list.push(t.label);
    labelsByBooking.set(t.bookingId, list);
  }

  return {
    ok: true,
    overdue: rows.map((r) => ({
      bookingId: r.id,
      guestFirstName: r.guestFirstName,
      partySize: r.partySize,
      tableLabels: (labelsByBooking.get(r.id) ?? []).sort(),
      endWall: formatVenueTime(r.endAt, { timezone: venue.timezone }),
      overdueMinutes: Math.max(1, Math.round((now.getTime() - r.endAt.getTime()) / 60_000)),
    })),
  };
}

export type OverdueActionResult =
  | { ok: true }
  | { ok: false; reason: "not-found" | "slot-taken" | "invalid" };

function revalidateFloorSurfaces(venueId: string) {
  revalidatePath(`/dashboard/venues/${venueId}/floor-plan`);
  revalidatePath(`/dashboard/venues/${venueId}/timeline`);
  revalidatePath(`/dashboard/venues/${venueId}/bookings`);
}

export async function finishOverdue(raw: unknown): Promise<OverdueActionResult> {
  const parsed = BookingArg.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: "invalid" };
  const { orgId, userId } = await requireRole("host");
  const venue = await venueInOrg(parsed.data.venueId, orgId);
  if (!venue) return { ok: false, reason: "not-found" };

  // Pin the booking to the passed venue (not just the org) so the
  // revalidation below always targets the right surfaces.
  const [booking] = await adminDb()
    .select({ venueId: bookings.venueId })
    .from(bookings)
    .where(and(eq(bookings.id, parsed.data.bookingId), eq(bookings.organisationId, orgId)))
    .limit(1);
  if (!booking || booking.venueId !== venue.id) return { ok: false, reason: "not-found" };

  const r = await transitionBooking(orgId, userId, parsed.data.bookingId, "finished");
  if (!r.ok) return { ok: false, reason: "not-found" };
  revalidateFloorSurfaces(venue.id);
  return { ok: true };
}

export async function extendOverdue(raw: unknown): Promise<OverdueActionResult> {
  const parsed = ExtendArg.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: "invalid" };
  const { orgId, userId } = await requireRole("host");
  const venue = await venueInOrg(parsed.data.venueId, orgId);
  if (!venue) return { ok: false, reason: "not-found" };

  const [booking] = await adminDb()
    .select({ endAt: bookings.endAt, venueId: bookings.venueId })
    .from(bookings)
    .where(and(eq(bookings.id, parsed.data.bookingId), eq(bookings.organisationId, orgId)))
    .limit(1);
  if (!booking || booking.venueId !== venue.id) return { ok: false, reason: "not-found" };

  // Extend from "now or the booked end, whichever is later" so a
  // long-overdue table gets a full fresh interval, not a stale one.
  const base = Math.max(Date.now(), booking.endAt.getTime());
  const newEndAt = new Date(base + parsed.data.minutes * 60_000);

  const r = await resizeBookingDuration({
    organisationId: orgId,
    actorUserId: userId,
    bookingId: parsed.data.bookingId,
    newEndAt,
  });
  if (!r.ok) {
    return { ok: false, reason: r.reason === "slot-taken" ? "slot-taken" : "not-found" };
  }
  revalidateFloorSurfaces(venue.id);
  return { ok: true };
}
