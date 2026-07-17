// Deposit-abandonment janitor.
//
// Two callers in Phase 1, both safe to run concurrently:
//
//   1. Daily Vercel Cron (`vercel.json` → /api/cron/deposit-janitor)
//      runs the full sweep at 03:00 — backstop for venues with no
//      daytime traffic. Vercel Hobby tier limits cron frequency to
//      once-per-day; once we move to Pro we can tighten this.
//
//   2. Inline call at the start of `POST /api/v1/bookings` runs a
//      venue-scoped sweep (`venueId` filter). Active venues get near-
//      realtime cleanup as a side-effect of the next booker arriving.
//
// In both cases: find bookings stuck in `requested` with a still-
// unconfirmed deposit older than TTL_MINUTES, cancel the Stripe
// PaymentIntent (if a real pi_* exists), transition the booking to
// cancelled with reason `deposit_abandoned`, mark the payments row
// canceled.
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

// Outcome of trying to neutralise a booking's PaymentIntent before we
// cancel the booking / release its inventory.
//
//   "safe"        — no confirmable intent remains (cancelled now, was
//                   already cancelled, or none ever reached Stripe).
//   "confirmable" — a live intent could still take the guest's money.
//                   The caller MUST NOT cancel the booking or release
//                   capacity: doing so lets a late payment land on a
//                   cancelled, released booking (charge-after-cancel /
//                   oversell). Skip the row; retry next sweep.
type IntentOutcome = "safe" | "confirmable";

// Cancel a PaymentIntent if one exists and report whether it's now
// impossible for it to succeed. Branches on the PI's actual status
// rather than regexing Stripe's error prose (which changes across API
// versions). Fails SHUT: if we can't reach Stripe or can't determine
// the status, we report "confirmable" or throw — never "safe".
async function neutraliseIntent(
  stripeIntentId: string,
  stripeAccount: string | null,
): Promise<IntentOutcome> {
  // Placeholder rows (`pending_<bookingId>`) never reached the DB with
  // a real id. A live PI may still exist in the rare create-then-DB-
  // fail race, but we can't address it by id; the status guard in the
  // payment_intent.succeeded handler converts that residue into an
  // operator alert + dashboard refund instead of a silent resurrect.
  if (!stripeIntentId.startsWith("pi_")) return "safe";

  // A real intent we cannot reach (kill switch on, or the org's
  // connected account row is gone) might still be confirmable in the
  // guest's open checkout — fail shut.
  if (!stripeEnabled() || !stripeAccount) return "confirmable";

  try {
    await stripe().paymentIntents.cancel(
      stripeIntentId,
      { cancellation_reason: "abandoned" },
      { stripeAccount },
    );
    return "safe";
  } catch (err) {
    if (!(err instanceof Stripe.errors.StripeInvalidRequestError)) throw err;
    // Cancel refused — ask Stripe what state the intent is really in.
    const pi = await stripe().paymentIntents.retrieve(stripeIntentId, {}, { stripeAccount });
    if (pi.status === "canceled") return "safe";
    // succeeded / processing / requires_capture — money moved or may
    // still move. Leave the row for the webhook to settle.
    return "confirmable";
  }
}

export async function sweepAbandonedDeposits(
  opts: { now?: Date; venueId?: string } = {},
): Promise<JanitorResult> {
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - TTL_MINUTES * 60 * 1000);

  if (paymentsDisabled()) return { swept: 0, failed: 0 };

  const db = adminDb();

  // Candidate bookings: status=requested, created_at < cutoff, and
  // a payments row exists for this booking with kind=deposit in a
  // not-yet-complete state. We join in SQL so the filter happens at
  // the DB level. The optional venueId narrows further — used by the
  // inline sweep on POST /api/v1/bookings.
  const where = and(
    eq(bookings.status, "requested"),
    lt(bookings.createdAt, cutoff),
    sql`${payments.status} in ('pending_creation','requires_payment_method','requires_action','processing')`,
    ...(opts.venueId ? [eq(bookings.venueId, opts.venueId)] : []),
  );
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
    .where(where);

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
      const outcome = await neutraliseIntent(
        row.stripeIntentId,
        await getStripeAccount(row.organisationId),
      );
      if (outcome === "confirmable") {
        // A live intent could still take the guest's money — cancelling
        // the booking now would free its tables (cancel trigger) while
        // payment can still land. Leave for the webhook / next sweep.
        failed += 1;
        continue;
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

// Event-ticket abandonment sweep (Phase 2). Same shape as the deposit sweep,
// plus the crucial extra step: RELEASE the reserved capacity by decrementing
// event_ticket_types.quantity_sold. The booking's requested→cancelled flip is
// the idempotency gate — the release only runs in the same transaction that
// wins that flip, so a retry (or a concurrent sweep) can never double-release
// and under-count sold tickets (which would let the event oversell).
export async function sweepAbandonedEventBookings(
  opts: { now?: Date; venueId?: string } = {},
): Promise<JanitorResult> {
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - TTL_MINUTES * 60 * 1000);

  if (paymentsDisabled()) return { swept: 0, failed: 0 };

  const db = adminDb();

  const where = and(
    eq(bookings.status, "requested"),
    lt(bookings.createdAt, cutoff),
    sql`${payments.status} in ('pending_creation','requires_payment_method','requires_action','processing')`,
    ...(opts.venueId ? [eq(bookings.venueId, opts.venueId)] : []),
  );
  const stale = await db
    .select({
      bookingId: bookings.id,
      organisationId: bookings.organisationId,
      paymentId: payments.id,
      stripeIntentId: payments.stripeIntentId,
    })
    .from(bookings)
    .innerJoin(
      payments,
      and(eq(payments.bookingId, bookings.id), eq(payments.kind, "event_ticket")),
    )
    .where(where);

  if (stale.length === 0) return { swept: 0, failed: 0 };

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
      // Neutralise the Intent first. Capacity may only be released
      // when no confirmable PI exists for the booking — otherwise a
      // late success lands on released inventory (oversell).
      const outcome = await neutraliseIntent(
        row.stripeIntentId,
        await getStripeAccount(row.organisationId),
      );
      if (outcome === "confirmable") {
        failed += 1;
        continue;
      }

      const released = await db.transaction(async (tx) => {
        // Gate: flip requested→cancelled. If another sweep already did, this
        // returns 0 rows and we skip the release (no double-decrement).
        const cancelled = await tx
          .update(bookings)
          .set({
            status: "cancelled",
            cancelledAt: sql`now()`,
            cancelledReason: "event_ticket_abandoned",
          })
          .where(and(eq(bookings.id, row.bookingId), eq(bookings.status, "requested")))
          .returning({ id: bookings.id });
        if (cancelled.length === 0) return false;

        // Release reserved capacity for this booking's order items.
        await tx.execute(sql`
          update event_ticket_types t
          set quantity_sold = greatest(0, t.quantity_sold - oi.qty)
          from (
            select ticket_type_id, sum(quantity)::int as qty
            from event_order_items
            where booking_id = ${row.bookingId}
            group by ticket_type_id
          ) oi
          where t.id = oi.ticket_type_id
        `);

        await tx.update(payments).set({ status: "canceled" }).where(eq(payments.id, row.paymentId));

        await tx.insert(bookingEvents).values({
          organisationId: row.organisationId,
          bookingId: row.bookingId,
          type: "booking.event_ticket.abandoned",
          actorUserId: null,
          meta: sql`${JSON.stringify({ paymentId: row.paymentId, intentId: row.stripeIntentId })}::jsonb`,
        });
        return true;
      });

      if (released) {
        await audit.log({
          organisationId: row.organisationId,
          actorUserId: null,
          action: "booking.event_ticket.abandoned",
          targetType: "booking",
          targetId: row.bookingId,
          metadata: {
            paymentId: row.paymentId,
            intentId: row.stripeIntentId,
            ttlMinutes: TTL_MINUTES,
          },
        });
        swept += 1;
      }
    } catch (err) {
      console.error("[lib/payments/janitor.ts] event sweep failed:", {
        bookingId: row.bookingId,
        paymentId: row.paymentId,
        message: err instanceof Error ? err.message : String(err),
      });
      failed += 1;
    }
  }

  return { swept, failed };
}
