// Webhook handler: setup_intent.setup_failed.
//
// Fires when a card-hold SetupIntent fails (3DS denied, card declined
// for SetupIntent purposes, etc.). We record the failure on the
// payments row; booking stays in 'requested' so the widget can retry
// against the same client_secret. The wave 6 janitor sweeps after 15
// min if abandoned.

import "server-only";

import type Stripe from "stripe";
import { eq, sql } from "drizzle-orm";

import { bookingEvents, payments } from "@/lib/db/schema";
import { audit } from "@/lib/server/admin/audit";
import { adminDb } from "@/lib/server/admin/db";

import { registerHandler } from "../webhook";

async function handleSetupIntentFailed(event: Stripe.Event): Promise<void> {
  const setup = event.data.object as Stripe.SetupIntent;
  const db = adminDb();

  const [payment] = await db
    .select({
      id: payments.id,
      bookingId: payments.bookingId,
      organisationId: payments.organisationId,
    })
    .from(payments)
    .where(eq(payments.stripeIntentId, setup.id))
    .limit(1);
  if (!payment) return;

  const lastError = setup.last_setup_error;
  await db
    .update(payments)
    .set({
      status: setup.status,
      failureCode: lastError?.code ?? null,
      failureMessage: lastError?.message ?? null,
    })
    .where(eq(payments.id, payment.id));

  await db.insert(bookingEvents).values({
    organisationId: payment.organisationId,
    bookingId: payment.bookingId,
    type: "payment.failed",
    actorUserId: null,
    meta: sql`${JSON.stringify({ paymentId: payment.id, setupIntentId: setup.id, failureCode: lastError?.code, failureMessage: lastError?.message })}::jsonb`,
  });

  await audit.log({
    organisationId: payment.organisationId,
    actorUserId: null,
    action: "stripe.setup_intent.failed",
    targetType: "payment",
    targetId: payment.id,
    metadata: { setupIntentId: setup.id, failureCode: lastError?.code },
  });
}

registerHandler("setup_intent.setup_failed", handleSetupIntentFailed);

export {};
