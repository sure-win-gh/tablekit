// No-show capture sweeper (flow B).
//
// Two callers, mirroring the abandonment janitor:
//
//   1. Daily cron (vercel.json → /api/cron/deposit-janitor) — Hobby
//      tier limits cron frequency to once per day, so the existing
//      route runs both the abandonment janitor and this sweeper in
//      sequence. Backstop for venues with no daytime traffic.
//
//   2. Inline call when the operator opens the bookings list page,
//      scoped to that venue. Service-time traffic drives near-real-
//      time captures.
//
// Logic: bookings still in `confirmed` after start_at + GRACE_MINUTES
// with a succeeded card-hold payment that hasn't already triggered a
// capture become candidates. We create an off-session PaymentIntent
// on the connected account using the stored payment_method, write a
// kind='no_show_capture' payments row tracking the result, and
// transition the booking to `no_show` regardless of capture outcome
// — they didn't turn up either way; only the recovered cash differs.
//
// Idempotent: the NOT EXISTS clause prevents a second capture for the
// same booking; the booking transition is also bound by status check.

import "server-only";

import { and, eq, sql } from "drizzle-orm";
import Stripe from "stripe";

import { bookingEvents, bookings, payments, stripeAccounts } from "@/lib/db/schema";
import { audit } from "@/lib/server/admin/audit";
import { adminDb } from "@/lib/server/admin/db";
import { paymentsDisabled, stripe, stripeEnabled } from "@/lib/stripe/client";

export const GRACE_MINUTES = 30;

export type NoShowSweepResult = {
  captured: number;
  failed: number;
};

export async function sweepDueNoShowCaptures(
  opts: { now?: Date; venueId?: string } = {},
): Promise<NoShowSweepResult> {
  if (paymentsDisabled() || !stripeEnabled()) return { captured: 0, failed: 0 };

  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - GRACE_MINUTES * 60 * 1000);

  const db = adminDb();

  // Candidate bookings — see file-level comment.
  const candidates = await db
    .select({
      bookingId: bookings.id,
      organisationId: bookings.organisationId,
      paymentId: payments.id,
      stripeCustomerId: payments.stripeCustomerId,
      stripePaymentMethodId: payments.stripePaymentMethodId,
      amountMinor: payments.amountMinor,
      currency: payments.currency,
    })
    .from(bookings)
    .innerJoin(payments, and(eq(payments.bookingId, bookings.id), eq(payments.kind, "hold")))
    .where(
      and(
        eq(bookings.status, "confirmed"),
        eq(payments.status, "succeeded"),
        sql`${bookings.startAt} + interval '${sql.raw(String(GRACE_MINUTES))} minutes' < ${cutoff.toISOString()}`,
        sql`${payments.stripeCustomerId} is not null`,
        sql`${payments.stripePaymentMethodId} is not null`,
        sql`not exists (select 1 from payments p2 where p2.booking_id = ${bookings.id} and p2.kind = 'no_show_capture')`,
        ...(opts.venueId ? [eq(bookings.venueId, opts.venueId)] : []),
      ),
    );

  if (candidates.length === 0) return { captured: 0, failed: 0 };

  // Cache org → connected account.
  const accountByOrg = new Map<string, string | null>();
  async function getStripeAccount(orgId: string): Promise<string | null> {
    if (accountByOrg.has(orgId)) return accountByOrg.get(orgId)!;
    const [row] = await db
      .select({ accountId: stripeAccounts.accountId })
      .from(stripeAccounts)
      .where(eq(stripeAccounts.organisationId, orgId))
      .limit(1);
    const id = row?.accountId ?? null;
    accountByOrg.set(orgId, id);
    return id;
  }

  let captured = 0;
  let failed = 0;

  for (const row of candidates) {
    if (!row.stripeCustomerId || !row.stripePaymentMethodId) continue;
    const acct = await getStripeAccount(row.organisationId);
    if (!acct) {
      // Org has lost its Connect account somehow — still mark the
      // booking no_show so the slot frees up.
      await markNoShowOnly(db, row);
      failed += 1;
      continue;
    }

    const idempotencyKey = `booking_${row.bookingId}_no_show_capture_v1`;
    let captureSucceeded = false;
    let captureIntentId: string | null = null;
    let captureFailureCode: string | null = null;
    let captureFailureMessage: string | null = null;

    try {
      const pi = await stripe().paymentIntents.create(
        {
          amount: row.amountMinor,
          currency: row.currency.toLowerCase(),
          customer: row.stripeCustomerId,
          payment_method: row.stripePaymentMethodId,
          off_session: true,
          confirm: true,
          capture_method: "automatic",
          metadata: {
            booking_id: row.bookingId,
            payment_id: row.paymentId,
            organisation_id: row.organisationId,
            kind: "no_show_capture",
          },
        },
        { idempotencyKey, stripeAccount: acct },
      );
      captureIntentId = pi.id;
      captureSucceeded = pi.status === "succeeded";
      if (!captureSucceeded) {
        captureFailureCode = pi.last_payment_error?.code ?? pi.status;
        captureFailureMessage = pi.last_payment_error?.message ?? null;
      }
    } catch (err) {
      // Off-session declines surface here as StripeCardError. Mark the
      // booking no_show anyway; operator can chase manually.
      if (err instanceof Stripe.errors.StripeCardError) {
        captureFailureCode = err.code ?? "card_error";
        captureFailureMessage = err.message;
        captureIntentId = err.payment_intent?.id ?? null;
      } else if (err instanceof Stripe.errors.StripeError) {
        captureFailureCode = err.code ?? "stripe_error";
        captureFailureMessage = err.message;
      } else {
        captureFailureCode = "unknown";
        captureFailureMessage = err instanceof Error ? err.message : String(err);
      }
    }

    // Insert no_show_capture row regardless of outcome — gives operators
    // an audit trail in the dashboard.
    await db.insert(payments).values({
      organisationId: row.organisationId,
      bookingId: row.bookingId,
      kind: "no_show_capture",
      stripeIntentId: captureIntentId ?? `failed_no_show_${row.bookingId}_${Date.now()}`,
      stripeCustomerId: row.stripeCustomerId,
      stripePaymentMethodId: row.stripePaymentMethodId,
      amountMinor: row.amountMinor,
      currency: row.currency,
      status: captureSucceeded ? "succeeded" : "failed",
      failureCode: captureFailureCode,
      failureMessage: captureFailureMessage,
    });

    await db
      .update(bookings)
      .set({ status: "no_show" })
      .where(and(eq(bookings.id, row.bookingId), eq(bookings.status, "confirmed")));

    await db.insert(bookingEvents).values({
      organisationId: row.organisationId,
      bookingId: row.bookingId,
      type: captureSucceeded ? "payment.succeeded" : "payment.failed",
      actorUserId: null,
      meta: sql`${JSON.stringify({
        kind: "no_show_capture",
        intentId: captureIntentId,
        amountMinor: row.amountMinor,
        failureCode: captureFailureCode,
      })}::jsonb`,
    });

    await audit.log({
      organisationId: row.organisationId,
      actorUserId: null,
      action: captureSucceeded
        ? "stripe.no_show_capture.succeeded"
        : "stripe.no_show_capture.failed",
      targetType: "payment",
      targetId: row.paymentId,
      metadata: {
        bookingId: row.bookingId,
        intentId: captureIntentId,
        failureCode: captureFailureCode,
      },
    });

    if (captureSucceeded) captured += 1;
    else failed += 1;
  }

  return { captured, failed };
}

// Failsafe path: org lost its connected account between hold-storage
// and capture-time. Free the table slot anyway; flag for operator.
async function markNoShowOnly(
  db: ReturnType<typeof adminDb>,
  row: { bookingId: string; organisationId: string; paymentId: string },
): Promise<void> {
  await db
    .update(bookings)
    .set({ status: "no_show" })
    .where(and(eq(bookings.id, row.bookingId), eq(bookings.status, "confirmed")));
  await audit.log({
    organisationId: row.organisationId,
    actorUserId: null,
    action: "stripe.no_show_capture.failed",
    targetType: "payment",
    targetId: row.paymentId,
    metadata: {
      bookingId: row.bookingId,
      reason: "no-connect-account",
    },
  });
}
