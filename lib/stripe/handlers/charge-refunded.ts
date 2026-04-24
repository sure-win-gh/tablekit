// Webhook handler: charge.refunded.
//
// Fires when one or more refunds are applied to a charge. The refund
// entries live in `charge.refunds.data[]`. We find our payments row
// (kind='refund') by stripe_intent_id = refund.id — wave 5 writes
// that row at refund-creation time with status='pending'.
//
// A charge.refunded event may cover a refund we don't own (e.g. a
// refund created directly from the Stripe dashboard rather than via
// our dashboard). Those refunds have no matching payments row here;
// we no-op for now. A reconciler could pick them up later.

import "server-only";

import type Stripe from "stripe";
import { eq, sql } from "drizzle-orm";

import { bookingEvents, payments } from "@/lib/db/schema";
import { audit } from "@/lib/server/admin/audit";
import { adminDb } from "@/lib/server/admin/db";

import { registerHandler } from "../webhook";

async function handleChargeRefunded(event: Stripe.Event): Promise<void> {
  const charge = event.data.object as Stripe.Charge;
  const refunds = charge.refunds?.data ?? [];
  if (refunds.length === 0) return;

  const db = adminDb();

  for (const refund of refunds) {
    const [existing] = await db
      .select({
        id: payments.id,
        bookingId: payments.bookingId,
        organisationId: payments.organisationId,
        status: payments.status,
      })
      .from(payments)
      .where(eq(payments.stripeIntentId, refund.id))
      .limit(1);

    if (!existing) continue; // dashboard-initiated or otherwise unknown
    if (existing.status === refund.status) continue; // idempotent

    await db
      .update(payments)
      .set({ status: refund.status ?? "succeeded" })
      .where(eq(payments.id, existing.id));

    await db.insert(bookingEvents).values({
      organisationId: existing.organisationId,
      bookingId: existing.bookingId,
      type: "payment.refunded",
      actorUserId: null,
      meta: sql`${JSON.stringify({ paymentId: existing.id, refundId: refund.id, amount: refund.amount })}::jsonb`,
    });

    await audit.log({
      organisationId: existing.organisationId,
      actorUserId: null,
      action: "stripe.refund.succeeded",
      targetType: "payment",
      targetId: existing.id,
      metadata: { refundId: refund.id, chargeId: charge.id, amount: refund.amount },
    });
  }
}

registerHandler("charge.refunded", handleChargeRefunded);

export {};
