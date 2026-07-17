// Event-ticket purchase — the native ticketing path (Phase 2).
//
// A purchase is a `booking` with source='event' (event_id set, no service/
// area/table). Capacity is reserved with an atomic conditional UPDATE on
// event_ticket_types.quantity_sold INSIDE the booking transaction: a
// concurrent buyer who grabbed the last ticket makes the WHERE fail (0 rows
// updated), rolling the whole purchase back. That — backstopped by the
// quantity_sold <= quantity_total check constraint — is what makes overselling
// structurally impossible. It is the event analogue of the booking_tables
// GIST constraint that standard bookings rely on.
//
// The Stripe PaymentIntent (kind='event_ticket', forced 3DS, Connect
// direct-charge) is created OUTSIDE the transaction, mirroring the deposit
// flow. On any failure after the reservation commits, the booking +
// reservation + placeholder payment are left for the event janitor to sweep
// and release. See docs/specs/special-events.md Phase 2.

import "server-only";

import { and, eq, sql } from "drizzle-orm";

import { isLocked } from "@/lib/auth/entitlements";
import { getPlan } from "@/lib/auth/require-plan";
import { type UpsertGuestRawInput } from "@/lib/guests/schema";
import { upsertGuest } from "@/lib/guests/upsert";
import {
  bookingEvents,
  bookings,
  eventOrderItems,
  eventTicketTypes,
  payments,
  specialEvents,
} from "@/lib/db/schema";
import { createEventTicketIntent, DepositIntentError } from "@/lib/payments/intents";
import { audit } from "@/lib/server/admin/audit";
import { adminDb } from "@/lib/server/admin/db";
import { stripeEnabled } from "@/lib/stripe/client";
import { getAccount } from "@/lib/stripe/connect";

export type EventPurchaseItem = { ticketTypeId: string; quantity: number };

export type CreateEventBookingInput = {
  eventId: string;
  items: EventPurchaseItem[];
  guest: UpsertGuestRawInput;
};

export type EventBookingResult =
  | {
      ok: true;
      bookingId: string;
      guestId: string;
      guestReused: boolean;
      amountMinor: number;
      clientSecret: string;
      stripeAccount: string;
    }
  | { ok: false; reason: "guest-invalid"; issues: string[] }
  | { ok: false; reason: "event-not-found" }
  | { ok: false; reason: "event-not-on-sale" }
  | { ok: false; reason: "invalid-items" }
  | { ok: false; reason: "sold-out" }
  | { ok: false; reason: "payments-unavailable" };

// Internal sentinel so a sold-out reservation rolls the transaction back
// and maps to a typed result rather than a 500.
class SoldOutError extends Error {}

export async function createEventBooking(
  input: CreateEventBookingInput,
  opts: { now?: Date } = {},
): Promise<EventBookingResult> {
  const now = opts.now ?? new Date();
  const db = adminDb();

  // 1. Resolve the event — must be published and not past.
  const [event] = await db
    .select({
      id: specialEvents.id,
      organisationId: specialEvents.organisationId,
      venueId: specialEvents.venueId,
      status: specialEvents.status,
      startsAt: specialEvents.startsAt,
      endsAt: specialEvents.endsAt,
      currency: specialEvents.currency,
    })
    .from(specialEvents)
    .where(eq(specialEvents.id, input.eventId))
    .limit(1);
  if (!event) return { ok: false, reason: "event-not-found" };
  if (event.status !== "published" || event.endsAt.getTime() <= now.getTime()) {
    return { ok: false, reason: "event-not-on-sale" };
  }
  const organisationId = event.organisationId;

  // Plus gate on the public path (spec §Gating): ticket types can only
  // be *created* on Plus, but a downgraded org must also stop selling.
  // Same guest-facing reason as an unpublished event — it's not the
  // buyer's problem which gate closed the sale.
  const plan = await getPlan(organisationId);
  if (isLocked(plan, "events")) return { ok: false, reason: "event-not-on-sale" };

  // 2. Validate requested items + compute the total. Quantities are collapsed
  //    per ticket type so a duplicate line can't dodge the max-per-order cap.
  const wantById = new Map<string, number>();
  for (const it of input.items) {
    if (!it.ticketTypeId || !Number.isInteger(it.quantity) || it.quantity < 1) {
      return { ok: false, reason: "invalid-items" };
    }
    wantById.set(it.ticketTypeId, (wantById.get(it.ticketTypeId) ?? 0) + it.quantity);
  }
  if (wantById.size === 0) return { ok: false, reason: "invalid-items" };

  const types = await db
    .select({
      id: eventTicketTypes.id,
      priceMinor: eventTicketTypes.priceMinor,
      maxPerOrder: eventTicketTypes.maxPerOrder,
    })
    .from(eventTicketTypes)
    .where(eq(eventTicketTypes.eventId, event.id));
  const typeById = new Map(types.map((t) => [t.id, t]));

  let amountMinor = 0;
  let partySize = 0;
  const lines: { ticketTypeId: string; quantity: number; unitPriceMinor: number }[] = [];
  for (const [ticketTypeId, quantity] of wantById) {
    const type = typeById.get(ticketTypeId);
    if (!type) return { ok: false, reason: "invalid-items" };
    if (quantity > type.maxPerOrder) return { ok: false, reason: "invalid-items" };
    amountMinor += type.priceMinor * quantity;
    partySize += quantity;
    lines.push({ ticketTypeId, quantity, unitPriceMinor: type.priceMinor });
  }
  // Free tickets aren't supported on the paid path (Stripe rejects a
  // zero-amount PaymentIntent). Revisit for RSVP-style events (Phase 3).
  if (amountMinor <= 0) return { ok: false, reason: "invalid-items" };
  // Stable lock order: two concurrent multi-tier orders reserving in
  // opposite client-supplied orders would deadlock (40P01 → guest 500).
  lines.sort((a, b) => a.ticketTypeId.localeCompare(b.ticketTypeId));

  // 3. Stripe must be live + the org's connected account able to charge.
  if (!stripeEnabled()) return { ok: false, reason: "payments-unavailable" };
  const account = await getAccount(organisationId);
  if (!account || !account.chargesEnabled) {
    return { ok: false, reason: "payments-unavailable" };
  }

  // 4. Upsert the guest (validates the payload).
  const guestR = await upsertGuest(organisationId, null, input.guest);
  if (!guestR.ok) return { ok: false, reason: "guest-invalid", issues: guestR.issues };

  // 5. Reserve + write, all in one transaction.
  let bookingId: string;
  let paymentId: string;
  try {
    const txOut = await db.transaction(async (tx) => {
      for (const line of lines) {
        const reserved = await tx
          .update(eventTicketTypes)
          .set({ quantitySold: sql`${eventTicketTypes.quantitySold} + ${line.quantity}` })
          .where(
            and(
              eq(eventTicketTypes.id, line.ticketTypeId),
              eq(eventTicketTypes.eventId, event.id),
              sql`${eventTicketTypes.quantitySold} + ${line.quantity} <= ${eventTicketTypes.quantityTotal}`,
            ),
          )
          .returning({ id: eventTicketTypes.id });
        if (reserved.length === 0) throw new SoldOutError();
      }

      const [inserted] = await tx
        .insert(bookings)
        .values({
          // org/venue are (re)set by enforce_bookings_org_and_venue from
          // event_id; we pass what we know to satisfy the NOT NULL types.
          organisationId,
          venueId: event.venueId,
          eventId: event.id,
          guestId: guestR.guestId,
          partySize,
          startAt: event.startsAt,
          endAt: event.endsAt,
          status: "requested",
          source: "event",
        })
        .returning({ id: bookings.id });
      if (!inserted) throw new Error("createEventBooking: booking insert returned no row");

      await tx.insert(eventOrderItems).values(
        lines.map((line) => ({
          organisationId,
          bookingId: inserted.id,
          ticketTypeId: line.ticketTypeId,
          quantity: line.quantity,
          unitPriceMinor: line.unitPriceMinor,
        })),
      );

      await tx.insert(bookingEvents).values({
        organisationId,
        bookingId: inserted.id,
        type: "status.requested",
        actorUserId: null,
        meta: sql`${JSON.stringify({ eventId: event.id, items: lines })}::jsonb`,
      });

      const [p] = await tx
        .insert(payments)
        .values({
          organisationId,
          bookingId: inserted.id,
          kind: "event_ticket",
          stripeIntentId: `pending_${inserted.id}`,
          amountMinor,
          currency: event.currency,
          status: "pending_creation",
        })
        .returning({ id: payments.id });
      if (!p) throw new Error("createEventBooking: placeholder payment insert returned no row");

      return { bookingId: inserted.id, paymentId: p.id };
    });
    bookingId = txOut.bookingId;
    paymentId = txOut.paymentId;
  } catch (err) {
    if (err instanceof SoldOutError) return { ok: false, reason: "sold-out" };
    throw err;
  }

  await audit.log({
    organisationId,
    actorUserId: null,
    action: "event_booking.created",
    targetType: "booking",
    targetId: bookingId,
    metadata: { eventId: event.id, partySize, amountMinor },
  });

  // 6. PaymentIntent out of transaction. On failure the reservation is left
  //    for the janitor; we don't leak Stripe diagnostics to the caller.
  try {
    const intent = await createEventTicketIntent({
      organisationId,
      bookingId,
      paymentId,
      guestId: guestR.guestId,
      amountMinor,
      currency: event.currency,
      stripeAccountId: account.accountId,
    });
    return {
      ok: true,
      bookingId,
      guestId: guestR.guestId,
      guestReused: guestR.reused,
      amountMinor,
      clientSecret: intent.clientSecret,
      stripeAccount: account.accountId,
    };
  } catch (err) {
    console.error("[lib/events/purchase.ts] event ticket intent failed:", {
      bookingId,
      paymentId,
      message: err instanceof DepositIntentError ? err.message : String(err),
    });
    return { ok: false, reason: "payments-unavailable" };
  }
}
