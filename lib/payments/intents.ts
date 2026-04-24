// Stripe deposit-Intent orchestration.
//
// Lives on the boundary between our booking transaction and Stripe's
// network call. The booking transaction commits a booking (status
// 'requested') plus a placeholder `payments` row (stripe_intent_id =
// `pending_<bookingId>`); this module picks up from there, talks to
// Stripe out-of-transaction, and promotes the placeholder to a real
// `pi_*` row. The janitor (wave 6) sweeps anything left pending for
// more than 15 minutes.
//
// Everything here runs on the org's connected account via
// `{ stripeAccount }`. No `on_behalf_of` or platform Customers — this
// is Connect Standard direct-charge. 3DS is forced per the PCI playbook.

import "server-only";

import { eq } from "drizzle-orm";
import Stripe from "stripe";

import { guests, payments } from "@/lib/db/schema";
import { audit } from "@/lib/server/admin/audit";
import { adminDb } from "@/lib/server/admin/db";
import { paymentsDisabled, stripe } from "@/lib/stripe/client";

import type { DepositRule } from "./rules";

export type CreateDepositIntentInput = {
  organisationId: string;
  bookingId: string;
  paymentId: string; // id of the placeholder `payments` row
  guestId: string;
  partySize: number;
  rule: DepositRule;
  stripeAccountId: string; // acct_*
};

export type CreateDepositIntentResult = {
  clientSecret: string;
  intentId: string; // pi_*
  amountMinor: number;
};

export class DepositIntentError extends Error {
  constructor(
    message: string,
    public readonly code: "payments-disabled" | "stripe-error" | "no-amount",
    cause?: unknown,
  ) {
    super(message);
    this.name = "DepositIntentError";
    if (cause) (this as { cause?: unknown }).cause = cause;
  }
}

// Total deposit amount in minor units. `card_hold` is flow B territory
// and shouldn't flow through the deposit path — guarded by the caller
// but asserted here too for defence-in-depth.
export function depositAmountMinor(rule: DepositRule, partySize: number): number {
  if (rule.kind === "card_hold") {
    throw new DepositIntentError("card_hold rule in deposit path", "no-amount");
  }
  if (rule.kind === "per_cover") return rule.amountMinor * partySize;
  return rule.amountMinor;
}

// Orchestrates Customer lookup/create, PaymentIntent create, and
// promoting the placeholder `payments` row to the real `pi_*`. Callers
// (booking-create) run this outside any transaction. On throw, the
// placeholder row stays `pending_creation` for the janitor to clean up.
export async function createDepositIntent(
  input: CreateDepositIntentInput,
): Promise<CreateDepositIntentResult> {
  if (paymentsDisabled()) {
    throw new DepositIntentError("payments kill-switch engaged", "payments-disabled");
  }

  const amount = depositAmountMinor(input.rule, input.partySize);
  if (amount <= 0) {
    // Stripe rejects zero-amount PaymentIntents. The schema already
    // blocks negative amounts on deposits.
    throw new DepositIntentError("deposit amount resolved to 0", "no-amount");
  }

  const db = adminDb();
  const s = stripe();

  try {
    // 1. Ensure a Stripe Customer exists on the connected account.
    //    Idempotency-keyed so two concurrent booking flows for the same
    //    guest converge on a single Customer record.
    const customerId = await ensureCustomer(db, s, input);

    // 2. Create the PaymentIntent on the connected account.
    const idempotencyKey = `booking_${input.bookingId}_deposit_v1`;
    const pi = await s.paymentIntents.create(
      {
        amount,
        currency: input.rule.currency.toLowerCase(),
        customer: customerId,
        capture_method: "automatic",
        confirmation_method: "automatic",
        payment_method_options: {
          card: { request_three_d_secure: "any" },
        },
        metadata: {
          booking_id: input.bookingId,
          payment_id: input.paymentId,
          organisation_id: input.organisationId,
          kind: "deposit",
        },
      },
      { idempotencyKey, stripeAccount: input.stripeAccountId },
    );

    if (!pi.client_secret) {
      // Stripe should never return a PI without a client_secret, but
      // TypeScript needs the narrowing and a missing one would be a
      // genuine bug.
      throw new DepositIntentError("PaymentIntent returned no client_secret", "stripe-error");
    }

    // 3. Promote the placeholder row to the real pi_*.
    await db
      .update(payments)
      .set({
        stripeIntentId: pi.id,
        stripeCustomerId: customerId,
        amountMinor: amount,
        status: pi.status,
      })
      .where(eq(payments.id, input.paymentId));

    await audit.log({
      organisationId: input.organisationId,
      actorUserId: null,
      action: "stripe.intent.created",
      targetType: "payment",
      targetId: input.paymentId,
      metadata: { intentId: pi.id, amountMinor: amount, kind: "deposit" },
    });

    return { clientSecret: pi.client_secret, intentId: pi.id, amountMinor: amount };
  } catch (err) {
    if (err instanceof DepositIntentError) throw err;
    const message = err instanceof Stripe.errors.StripeError ? err.message : (err as Error).message;
    throw new DepositIntentError(message, "stripe-error", err);
  }
}

// Look up guests.stripe_customer_id; if null, create a Customer on the
// connected account and persist. Idempotency-keyed on the guest id so
// two concurrent calls converge on the same Stripe Customer.
//
// We don't send email / name to Stripe — the booking → guest link is
// encoded in the PaymentIntent's metadata. Operators see their bookings
// via metadata, and we keep guest PII inside our encrypted guests row.
async function ensureCustomer(
  db: ReturnType<typeof adminDb>,
  s: Stripe,
  input: CreateDepositIntentInput,
): Promise<string> {
  const [guest] = await db
    .select({ stripeCustomerId: guests.stripeCustomerId })
    .from(guests)
    .where(eq(guests.id, input.guestId))
    .limit(1);
  if (guest?.stripeCustomerId) return guest.stripeCustomerId;

  const customer = await s.customers.create(
    {
      metadata: {
        guest_id: input.guestId,
        organisation_id: input.organisationId,
      },
    },
    {
      idempotencyKey: `guest_${input.guestId}_customer_v1`,
      stripeAccount: input.stripeAccountId,
    },
  );

  await db
    .update(guests)
    .set({ stripeCustomerId: customer.id })
    .where(eq(guests.id, input.guestId));

  return customer.id;
}
