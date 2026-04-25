// Server-callable booking state transition.
//
// Gate: caller already verified role. This function only checks the
// transition is legal and the booking belongs to `organisationId`.
// Writes under adminDb — there are no UPDATE policies for authenticated
// on bookings (same pattern as every other tenant table in this app).
//
// On 'cancelled', the `clear_booking_tables_on_cancel` DB trigger frees
// the junction rows, so a future booking can claim the table again.

import "server-only";

import { and, eq } from "drizzle-orm";

import { bookingEvents, bookings } from "@/lib/db/schema";
import { onBookingCancelled, onBookingFinished } from "@/lib/messaging/triggers";
import { audit } from "@/lib/server/admin/audit";
import { adminDb } from "@/lib/server/admin/db";

import { InvalidTransitionError, assertTransition, type BookingStatus } from "./state";

export type TransitionBookingResult =
  | { ok: true; from: BookingStatus; to: BookingStatus }
  | { ok: false; reason: "not-found" }
  | { ok: false; reason: "invalid-transition"; from: BookingStatus; to: BookingStatus };

export async function transitionBooking(
  organisationId: string,
  actorUserId: string | null,
  bookingId: string,
  to: BookingStatus,
  options?: { cancelledReason?: string },
): Promise<TransitionBookingResult> {
  const db = adminDb();

  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({ id: bookings.id, status: bookings.status })
      .from(bookings)
      .where(and(eq(bookings.id, bookingId), eq(bookings.organisationId, organisationId)))
      .limit(1);
    if (!current) return { ok: false, reason: "not-found" };

    const from = current.status as BookingStatus;

    try {
      assertTransition(from, to);
    } catch (err) {
      if (err instanceof InvalidTransitionError) {
        return { ok: false, reason: "invalid-transition", from, to };
      }
      throw err;
    }

    const patch: {
      status: BookingStatus;
      cancelledAt?: Date;
      cancelledReason?: string;
    } = { status: to };
    if (to === "cancelled") {
      patch.cancelledAt = new Date();
      if (options?.cancelledReason) patch.cancelledReason = options.cancelledReason;
    }

    await tx.update(bookings).set(patch).where(eq(bookings.id, bookingId));

    await tx.insert(bookingEvents).values({
      organisationId,
      bookingId,
      type: `status.${to}`,
      actorUserId,
      meta: { from },
    });

    await audit.log({
      organisationId,
      actorUserId,
      action: "booking.transitioned",
      targetType: "booking",
      targetId: bookingId,
      metadata: {
        from,
        to,
        ...(options?.cancelledReason ? { cancelledReason: options.cancelledReason } : {}),
      },
    });

    // Fire messaging triggers. Wrapped so a messaging failure can
    // never roll back the transition the operator just made.
    if (to === "cancelled") {
      void onBookingCancelled({ organisationId, bookingId }).catch((err) => {
        console.error("[lib/bookings/transition.ts] onBookingCancelled failed:", {
          bookingId,
          message: err instanceof Error ? err.message : String(err),
        });
      });
    } else if (to === "finished") {
      void onBookingFinished({ organisationId, bookingId }).catch((err) => {
        console.error("[lib/bookings/transition.ts] onBookingFinished failed:", {
          bookingId,
          message: err instanceof Error ? err.message : String(err),
        });
      });
    }

    return { ok: true, from, to };
  });
}
