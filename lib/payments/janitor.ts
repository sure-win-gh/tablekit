// Deposit-abandonment janitor.
//
// Runs every 5 minutes via Vercel Cron (see vercel.json → /api/cron/
// deposit-janitor). Finds bookings stuck in `requested` with a still-
// unconfirmed deposit older than TTL_MINUTES, cancels the Stripe
// PaymentIntent (if a real pi_* exists), transitions the booking to
// cancelled with reason `deposit_abandoned`, and marks the payments
// row canceled.
//
// Idempotent: a second run over the same state is a no-op because the
// WHERE clause only matches bookings still in `requested`. Stripe's
// cancel is also idempotent for PIs in requires_* states.

import "server-only";

import { and, eq, lt, sql } from "drizzle-orm";
import Stripe from "stripe";

import { bookingEvents, bookings, payments, stripeAccounts } from "@/lib/db/schema";
import { audit } from "@/lib/server/admin/audit";
import { adminDb } from "@/lib/server/admin/db";
import { paymentsDisabled, stripe, stripeEnabled } from "@/lib/stripe/client";

export const TTL_MINUTES = 15;

export type JanitorResult = {
  swept: number;
  failed: number;
};

export async function sweepAbandonedDeposits(opts: { now?: Date } = {}): Promise<JanitorResult> {
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - TTL_MINUTES * 60 * 1000);

  if (paymentsDisabled()) return { swept: 0, failed: 0 };

  const db = adminDb();

  // Candidate bookings: status=requested, created_at < cutoff, and
  // a payments row exists for this booking with kind=deposit in a
  // not-yet-complete state. We join in SQL so the filter happens at
  // the DB level.
  const stale = await db
    .select({
      bookingId: bookings.id,
      organisationId: bookings.organisationId,
      paymentId: payments.id,
      stripeIntentId: payments.stripeIntentId,
      paymentStatus: payments.status,
    })
    .from(bookings)
    .innerJoin(payments, and(eq(payments.bookingId, bookings.id), eq(payments.kind, "deposit")))
    .where(
      and(
        eq(bookings.status, "requested"),
        lt(bookings.createdAt, cutoff),
        sql`${payments.status} in ('pending_creation','requires_payment_method','requires_action','processing')`,
      ),
    );

  if (stale.length === 0) return { swept: 0, failed: 0 };

  // Org → connected account lookup. Cache per org to avoid duplicate
  // queries when multiple stuck bookings share an org.
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

  let swept = 0;
  let failed = 0;

  for (const row of stale) {
    try {
      // Only call Stripe if the intent id is real (pi_*). Placeholder
      // rows (`pending_<bookingId>`) never hit Stripe, so there's
      // nothing to cancel there.
      const isRealIntent = row.stripeIntentId.startsWith("pi_");
      if (isRealIntent && stripeEnabled()) {
        const acct = await getStripeAccount(row.organisationId);
        if (acct) {
          try {
            await stripe().paymentIntents.cancel(
              row.stripeIntentId,
              { cancellation_reason: "abandoned" },
              { stripeAccount: acct },
            );
          } catch (err) {
            // Already canceled / already succeeded → fine, swallow.
            // Network / auth errors → rethrow to the outer catch so
            // the row counts as failed and the janitor tries again
            // next tick.
            if (
              err instanceof Stripe.errors.StripeInvalidRequestError &&
              /already|cannot be captured|in a terminal state/i.test(err.message)
            ) {
              // No-op. The booking transition still runs so the slot
              // is released.
            } else {
              throw err;
            }
          }
        }
      }

      await db.update(payments).set({ status: "canceled" }).where(eq(payments.id, row.paymentId));

      await db
        .update(bookings)
        .set({
          status: "cancelled",
          cancelledAt: sql`now()`,
          cancelledReason: "deposit_abandoned",
        })
        .where(eq(bookings.id, row.bookingId));

      await db.insert(bookingEvents).values({
        organisationId: row.organisationId,
        bookingId: row.bookingId,
        type: "booking.deposit.abandoned",
        actorUserId: null,
        meta: sql`${JSON.stringify({ paymentId: row.paymentId, intentId: row.stripeIntentId })}::jsonb`,
      });

      await audit.log({
        organisationId: row.organisationId,
        actorUserId: null,
        action: "booking.deposit.abandoned",
        targetType: "booking",
        targetId: row.bookingId,
        metadata: {
          paymentId: row.paymentId,
          intentId: row.stripeIntentId,
          ttlMinutes: TTL_MINUTES,
        },
      });

      swept += 1;
    } catch (err) {
      console.error("[lib/payments/janitor.ts] sweep failed:", {
        bookingId: row.bookingId,
        paymentId: row.paymentId,
        message: err instanceof Error ? err.message : String(err),
      });
      failed += 1;
    }
  }

  return { swept, failed };
}
