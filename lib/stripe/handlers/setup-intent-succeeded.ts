// Webhook handler: setup_intent.succeeded.
//
// Fires on the connected account when a card-hold SetupIntent is
// confirmed (with or without 3DS). We:
//   1. Find the placeholder `payments` row (kind='hold') for this
//      SetupIntent — by stripe_intent_id, falling back to
//      metadata.payment_id for the wave 2 placeholder→real race.
//   2. Promote it to status='succeeded', recording the
//      payment_method id + customer id so the no-show capture path
//      can charge off-session.
//   3. Transition the booking to 'confirmed' (idempotent).
//   4. Append a payment.succeeded booking_event.
//
// Idempotent. Replay no-ops once status is succeeded.

import "server-only";

import type Stripe from "stripe";
import { eq, sql } from "drizzle-orm";

import { bookingEvents, bookings, payments } from "@/lib/db/schema";
import { audit } from "@/lib/server/admin/audit";
import { adminDb } from "@/lib/server/admin/db";

import { registerHandler } from "../webhook";

async function handleSetupIntentSucceeded(event: Stripe.Event): Promise<void> {
  const setup = event.data.object as Stripe.SetupIntent;
  const db = adminDb();

  const paymentId =
    typeof setup.metadata?.["payment_id"] === "string" ? setup.metadata["payment_id"] : null;

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
      .where(eq(payments.stripeIntentId, setup.id))
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

  if (!payment) return;
  if (payment.status === "succeeded") return;

  const paymentMethodId =
    typeof setup.payment_method === "string"
      ? setup.payment_method
      : (setup.payment_method?.id ?? null);
  const customerId =
    typeof setup.customer === "string" ? setup.customer : (setup.customer?.id ?? null);

  await db
    .update(payments)
    .set({
      status: "succeeded",
      stripeIntentId: setup.id,
      stripePaymentMethodId: paymentMethodId,
      stripeCustomerId: customerId,
    })
    .where(eq(payments.id, payment.id));

  await db
    .update(bookings)
    .set({ status: "confirmed", depositIntentId: setup.id })
    .where(eq(bookings.id, payment.bookingId));

  await db.insert(bookingEvents).values({
    organisationId: payment.organisationId,
    bookingId: payment.bookingId,
    type: "payment.succeeded",
    actorUserId: null,
    meta: sql`${JSON.stringify({ paymentId: payment.id, setupIntentId: setup.id, kind: "hold" })}::jsonb`,
  });

  await audit.log({
    organisationId: payment.organisationId,
    actorUserId: null,
    action: "stripe.setup_intent.succeeded",
    targetType: "payment",
    targetId: payment.id,
    metadata: {
      setupIntentId: setup.id,
      bookingId: payment.bookingId,
      customerId,
      paymentMethodId,
    },
  });
}

registerHandler("setup_intent.succeeded", handleSetupIntentSucceeded);

export {};
