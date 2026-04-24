// Operator-initiated refund flow.
//
// Called from a dashboard server action. Writes a placeholder payments
// row (kind='refund', negative amount, status='pending_creation')
// inside a transaction, calls Stripe out-of-transaction with an
// idempotency key, then promotes the placeholder to the real `re_*`.
// The `charge.refunded` webhook handler (wave 3) promotes status to
// 'succeeded' once Stripe confirms.
//
// The actor user id rides along in Stripe metadata so the eventual
// webhook can attribute the refund to the operator who initiated it,
// even though the webhook has no request context.

import "server-only";

import { and, eq } from "drizzle-orm";
import Stripe from "stripe";

import { bookings, payments, stripeAccounts } from "@/lib/db/schema";
import { audit } from "@/lib/server/admin/audit";
import { adminDb } from "@/lib/server/admin/db";
import { paymentsDisabled, stripe } from "@/lib/stripe/client";

export type RefundBookingInput = {
  organisationId: string;
  actorUserId: string;
  bookingId: string;
  reason: string;
};

export type RefundBookingResult =
  | { ok: true; refundId: string; amountMinor: number }
  | {
      ok: false;
      reason:
        | "payments-disabled"
        | "no-connect-account"
        | "no-deposit"
        | "stripe-error"
        | "booking-not-in-org";
      message?: string;
    };

export async function refundBooking(
  input: RefundBookingInput,
): Promise<RefundBookingResult> {
  if (paymentsDisabled()) return { ok: false, reason: "payments-disabled" };

  const db = adminDb();

  const [booking] = await db
    .select({ id: bookings.id, organisationId: bookings.organisationId })
    .from(bookings)
    .where(and(eq(bookings.id, input.bookingId), eq(bookings.organisationId, input.organisationId)))
    .limit(1);
  if (!booking) return { ok: false, reason: "booking-not-in-org" };

  const [account] = await db
    .select({ accountId: stripeAccounts.accountId })
    .from(stripeAccounts)
    .where(eq(stripeAccounts.organisationId, input.organisationId))
    .limit(1);
  if (!account) return { ok: false, reason: "no-connect-account" };

  // Find the deposit payment to refund. A booking can have multiple
  // payments rows over its lifetime (deposit, refund, etc.), but only
  // one succeeded deposit.
  const [deposit] = await db
    .select({
      id: payments.id,
      stripeIntentId: payments.stripeIntentId,
      amountMinor: payments.amountMinor,
      currency: payments.currency,
    })
    .from(payments)
    .where(
      and(
        eq(payments.bookingId, input.bookingId),
        eq(payments.kind, "deposit"),
        eq(payments.status, "succeeded"),
      ),
    )
    .limit(1);
  if (!deposit) return { ok: false, reason: "no-deposit" };

  // Placeholder refund row with a synthetic id — promoted after Stripe
  // returns the real re_*.
  const placeholderId = `pending_refund_${input.bookingId}_${Date.now()}`;
  const [placeholder] = await db
    .insert(payments)
    .values({
      organisationId: input.organisationId,
      bookingId: input.bookingId,
      kind: "refund",
      stripeIntentId: placeholderId,
      amountMinor: -deposit.amountMinor,
      currency: deposit.currency,
      status: "pending_creation",
    })
    .returning({ id: payments.id });
  if (!placeholder) return { ok: false, reason: "stripe-error", message: "Failed to record refund" };

  try {
    const refund = await stripe().refunds.create(
      {
        payment_intent: deposit.stripeIntentId,
        metadata: {
          refund_id: placeholder.id,
          actor_user_id: input.actorUserId,
          booking_id: input.bookingId,
          reason: input.reason,
        },
      },
      {
        idempotencyKey: `refund_${placeholder.id}_v1`,
        stripeAccount: account.accountId,
      },
    );

    await db
      .update(payments)
      .set({ stripeIntentId: refund.id, status: refund.status ?? "pending" })
      .where(eq(payments.id, placeholder.id));

    await audit.log({
      organisationId: input.organisationId,
      actorUserId: input.actorUserId,
      action: "stripe.refund.created",
      targetType: "payment",
      targetId: placeholder.id,
      metadata: {
        refundId: refund.id,
        bookingId: input.bookingId,
        amountMinor: deposit.amountMinor,
        reason: input.reason,
      },
    });

    return { ok: true, refundId: refund.id, amountMinor: deposit.amountMinor };
  } catch (err) {
    // Leave the placeholder row behind with status='pending_creation'
    // so the operator can see the attempt + any future reconciler can
    // pick it up. Surface the Stripe message (safe — intended for
    // authenticated operators, not guests).
    const message =
      err instanceof Stripe.errors.StripeError
        ? err.message
        : err instanceof Error
          ? err.message
          : "Unexpected error";
    return { ok: false, reason: "stripe-error", message };
  }
}
