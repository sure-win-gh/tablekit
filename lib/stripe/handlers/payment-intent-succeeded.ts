// Webhook handler: payment_intent.succeeded.
//
// Fires on the connected account when a deposit PaymentIntent finishes
// confirmation (with or without 3DS). We:
//   1. Locate the `payments` row by stripe_intent_id, with a fallback
//      to metadata.payment_id in the rare race where this event lands
//      before the wave 2b placeholder→real update has committed.
//   2. Update the payments row to succeeded.
//   3. Transition the booking to `confirmed` (idempotent — a booking
//      already confirmed stays confirmed).
//   4. Append a `booking_events` row so the timeline has a trace.
//
// Idempotent. A replay will no-op on steps 2–4 because the status is
// already succeeded and the booking is already confirmed.

import "server-only";

import type Stripe from "stripe";
import { eq, sql } from "drizzle-orm";

import { bookingEvents, bookings, payments } from "@/lib/db/schema";
import { audit } from "@/lib/server/admin/audit";
import { adminDb } from "@/lib/server/admin/db";

import { registerHandler } from "../webhook";

async function handlePaymentIntentSucceeded(event: Stripe.Event): Promise<void> {
  const pi = event.data.object as Stripe.PaymentIntent;
  const db = adminDb();

  const paymentId =
    typeof pi.metadata?.["payment_id"] === "string" ? pi.metadata["payment_id"] : null;

  // Primary lookup: by real pi_*. Fallback to metadata.payment_id so
  // a webhook racing wave 2b's placeholder update still finds the row.
  const [payment] = await (async () => {
    const byIntent = await db
      .select({
        id: payments.id,
        bookingId: payments.bookingId,
        organisationId: payments.organisationId,
        status: payments.status,
        kind: payments.kind,
      })
      .from(payments)
      .where(eq(payments.stripeIntentId, pi.id))
      .limit(1);
    if (byIntent.length) return byIntent;
    if (paymentId) {
      return db
        .select({
          id: payments.id,
          bookingId: payments.bookingId,
          organisationId: payments.organisationId,
          status: payments.status,
          kind: payments.kind,
        })
        .from(payments)
        .where(eq(payments.id, paymentId))
        .limit(1);
    }
    return [];
  })();

  if (!payment) {
    // Nothing to do. The event row stays in stripe_events without
    // handled_at so we can replay it once the owning payments row
    // exists (e.g. via stripe listen --print-secret replay).
    return;
  }

  // Already processed? (idempotent no-op)
  if (payment.status === "succeeded") return;

  await db
    .update(payments)
    .set({
      status: "succeeded",
      stripeIntentId: pi.id, // in case we found the row via metadata fallback
      amountMinor: pi.amount_received || pi.amount,
    })
    .where(eq(payments.id, payment.id));

  await db
    .update(bookings)
    .set({ status: "confirmed", depositIntentId: pi.id })
    .where(eq(bookings.id, payment.bookingId));

  await db.insert(bookingEvents).values({
    organisationId: payment.organisationId,
    bookingId: payment.bookingId,
    type: "payment.succeeded",
    actorUserId: null,
    meta: sql`${JSON.stringify({ paymentId: payment.id, intentId: pi.id, amountMinor: pi.amount_received || pi.amount })}::jsonb`,
  });

  await audit.log({
    organisationId: payment.organisationId,
    actorUserId: null,
    action: "stripe.intent.succeeded",
    targetType: "payment",
    targetId: payment.id,
    metadata: { intentId: pi.id, bookingId: payment.bookingId, kind: payment.kind },
  });
}

registerHandler("payment_intent.succeeded", handlePaymentIntentSucceeded);

export {};
