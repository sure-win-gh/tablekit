// Webhook handler: payment_intent.payment_failed.
//
// Fires when Stripe rejects an Intent — expired, declined, 3DS denied.
// We record the failure on the payments row; the booking stays in
// `requested` so the widget can retry confirmation with the same
// client_secret (Stripe supports retrying a failed PI up until it's
// canceled). The janitor (wave 6) sweeps anything still-requested
// after 15 min.

import "server-only";

import type Stripe from "stripe";
import { eq, sql } from "drizzle-orm";

import { bookingEvents, payments } from "@/lib/db/schema";
import { audit } from "@/lib/server/admin/audit";
import { adminDb } from "@/lib/server/admin/db";

import { registerHandler } from "../webhook";

async function handlePaymentIntentFailed(event: Stripe.Event): Promise<void> {
  const pi = event.data.object as Stripe.PaymentIntent;
  const db = adminDb();

  const [payment] = await db
    .select({
      id: payments.id,
      bookingId: payments.bookingId,
      organisationId: payments.organisationId,
    })
    .from(payments)
    .where(eq(payments.stripeIntentId, pi.id))
    .limit(1);
  if (!payment) return;

  const lastError = pi.last_payment_error;
  await db
    .update(payments)
    .set({
      status: pi.status,
      failureCode: lastError?.code ?? null,
      failureMessage: lastError?.message ?? null,
    })
    .where(eq(payments.id, payment.id));

  await db.insert(bookingEvents).values({
    organisationId: payment.organisationId,
    bookingId: payment.bookingId,
    type: "payment.failed",
    actorUserId: null,
    meta: sql`${JSON.stringify({ paymentId: payment.id, intentId: pi.id, failureCode: lastError?.code, failureMessage: lastError?.message })}::jsonb`,
  });

  await audit.log({
    organisationId: payment.organisationId,
    actorUserId: null,
    action: "stripe.intent.failed",
    targetType: "payment",
    targetId: payment.id,
    metadata: { intentId: pi.id, failureCode: lastError?.code },
  });
}

registerHandler("payment_intent.payment_failed", handlePaymentIntentFailed);

export {};
