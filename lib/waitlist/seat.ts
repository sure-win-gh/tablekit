// Seat a waitlist entry — host's "seat now" tap.
//
// Creates a booking with source='walk-in', status='seated' directly
// (the host has confirmed they're at the table; no need to pass
// through requested/confirmed). Marks the waitlist row seated +
// links seated_booking_id. Enqueues the booking.waitlist_ready SMS
// so the guest gets a "your table's ready" ping if they wandered off.
//
// Service selection is auto: pick any service active today at the
// venue. If none, error — host needs to set up a service first.
// Walk-ins inherit the chosen service's turn time for the booking
// duration.

import "server-only";

import { and, eq, sql } from "drizzle-orm";

import {
  bookingEvents,
  bookingTables,
  bookings,
  services,
  venueTables,
  waitlists,
} from "@/lib/db/schema";
import { enqueueMessage } from "@/lib/messaging/enqueue";
import { processNextBatch } from "@/lib/messaging/dispatch";
import { audit } from "@/lib/server/admin/audit";
import { adminDb } from "@/lib/server/admin/db";

export type SeatWaitlistResult =
  | { ok: true; bookingId: string }
  | {
      ok: false;
      reason: "not-found" | "wrong-status" | "no-service" | "table-not-in-venue" | "slot-taken";
    };

export async function seatWaitlist(
  organisationId: string,
  actorUserId: string,
  input: { waitlistId: string; tableId: string },
): Promise<SeatWaitlistResult> {
  const db = adminDb();

  const [wl] = await db
    .select({
      id: waitlists.id,
      venueId: waitlists.venueId,
      guestId: waitlists.guestId,
      partySize: waitlists.partySize,
      status: waitlists.status,
    })
    .from(waitlists)
    .where(and(eq(waitlists.id, input.waitlistId), eq(waitlists.organisationId, organisationId)))
    .limit(1);
  if (!wl) return { ok: false, reason: "not-found" };
  if (wl.status !== "waiting") return { ok: false, reason: "wrong-status" };

  const [table] = await db
    .select({ id: venueTables.id, venueId: venueTables.venueId, areaId: venueTables.areaId })
    .from(venueTables)
    .where(and(eq(venueTables.id, input.tableId), eq(venueTables.organisationId, organisationId)))
    .limit(1);
  if (!table || table.venueId !== wl.venueId) {
    return { ok: false, reason: "table-not-in-venue" };
  }

  const [service] = await db
    .select({ id: services.id, turnMinutes: services.turnMinutes })
    .from(services)
    .where(eq(services.venueId, wl.venueId))
    .limit(1);
  if (!service) return { ok: false, reason: "no-service" };

  const startAt = new Date();
  const endAt = new Date(startAt.getTime() + service.turnMinutes * 60 * 1000);

  let bookingId: string;
  try {
    bookingId = await db.transaction(async (tx) => {
      const [booking] = await tx
        .insert(bookings)
        .values({
          organisationId, // overwritten by enforce_bookings trigger
          venueId: wl.venueId,
          serviceId: service.id,
          areaId: table.areaId,
          guestId: wl.guestId,
          partySize: wl.partySize,
          startAt,
          endAt,
          status: "seated",
          source: "walk-in",
          bookedByUserId: actorUserId,
        })
        .returning({ id: bookings.id });
      if (!booking) throw new Error("seatWaitlist: booking insert returned no row");

      await tx.insert(bookingTables).values({
        bookingId: booking.id,
        tableId: table.id,
        // Overwritten by the enforce_booking_tables trigger.
        organisationId,
        venueId: wl.venueId,
        areaId: table.areaId,
        startAt,
        endAt,
      });

      await tx.insert(bookingEvents).values({
        organisationId,
        bookingId: booking.id,
        type: "status.seated",
        actorUserId,
        meta: sql`${JSON.stringify({ source: "walk-in", waitlistId: wl.id })}::jsonb`,
      });

      await tx
        .update(waitlists)
        .set({ status: "seated", seatedBookingId: booking.id, seatedAt: new Date() })
        .where(eq(waitlists.id, wl.id));

      return booking.id;
    });
  } catch (err: unknown) {
    if (err && typeof err === "object" && (err as { code?: string }).code === "23P01") {
      return { ok: false, reason: "slot-taken" };
    }
    throw err;
  }

  await audit.log({
    organisationId,
    actorUserId,
    action: "waitlist.seated",
    targetType: "waitlist",
    targetId: wl.id,
    metadata: { bookingId, venueId: wl.venueId, tableId: table.id },
  });

  // Fire the ready-SMS. Wrapped so a messaging hiccup doesn't block
  // the seat-now flow the host just took.
  void (async () => {
    try {
      await enqueueMessage({
        organisationId,
        bookingId,
        template: "booking.waitlist_ready",
        channel: "sms",
      });
      await processNextBatch({ limit: 5 });
    } catch (err) {
      console.error("[lib/waitlist/seat.ts] waitlist_ready dispatch failed:", {
        bookingId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  })();

  return { ok: true, bookingId };
}
