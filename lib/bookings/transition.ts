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
import { dispatchEvent } from "@/lib/webhooks/dispatch";
import type { WebhookEvent } from "@/lib/webhooks/events";

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

    // Outbound webhook for the matching subscribed event. Map the
    // booking_status enum to our public event taxonomy. `requested`,
    // `confirmed`, and `finished` don't have dedicated public events
    // — they fall under `booking.updated` so subscribers can react
    // to the status change generically.
    const eventType = transitionToEventType(to);
    void dispatchEvent({
      organisationId,
      eventType,
      eventId: `${eventType}:${bookingId}:${Date.now()}`,
      payload: {
        booking_id: bookingId,
        from,
        to,
        ...(options?.cancelledReason ? { cancelled_reason: options.cancelledReason } : {}),
      },
    }).catch((err) => {
      console.error("[lib/bookings/transition.ts] webhook dispatch failed:", {
        bookingId,
        message: err instanceof Error ? err.message : String(err),
      });
    });

    return { ok: true, from, to };
  });
}

// Map booking_status enum → public webhook event. The five public
// events the spec promises are subscribers' contract; status values
// without a dedicated event collapse to `booking.updated` so the
// subscriber sees every state change. Exported for unit testing.
export function transitionToEventType(to: BookingStatus): WebhookEvent {
  switch (to) {
    case "cancelled":
      return "booking.cancelled";
    case "seated":
      return "booking.seated";
    case "no_show":
      return "booking.no_show";
    case "requested":
    case "confirmed":
    case "finished":
      return "booking.updated";
  }
}
