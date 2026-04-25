// Stripe SetupIntent orchestration for flow B — card hold.
//
// Mirrors createDepositIntent (lib/payments/intents.ts) in shape and
// transaction-boundary discipline. The difference is no money moves at
// booking time: a SetupIntent stores the guest's payment method on the
// connected account so we can charge off-session if the booking later
// becomes a no-show (lib/payments/no-show.ts handles the capture).
//
// `usage: 'off_session'` is required for the later capture to succeed
// without a 3DS challenge from the customer's bank — Stripe forces
// 3DS at confirmation time instead, so SCA is satisfied up front.

import "server-only";

import { eq } from "drizzle-orm";
import Stripe from "stripe";

import { guests, payments } from "@/lib/db/schema";
import { audit } from "@/lib/server/admin/audit";
import { adminDb } from "@/lib/server/admin/db";
import { paymentsDisabled, stripe } from "@/lib/stripe/client";

import type { DepositRule } from "./rules";

export type CreateCardHoldIntentInput = {
  organisationId: string;
  bookingId: string;
  paymentId: string; // id of the placeholder `payments` row (kind='hold')
  guestId: string;
  partySize: number;
  rule: DepositRule;
  stripeAccountId: string; // acct_*
};

export type CreateCardHoldIntentResult = {
  clientSecret: string;
  setupIntentId: string; // seti_*
  amountMinor: number; // the amount we'll capture if no-show
};

export class CardHoldIntentError extends Error {
  constructor(
    message: string,
    public readonly code: "payments-disabled" | "stripe-error" | "no-amount" | "wrong-kind",
    cause?: unknown,
  ) {
    super(message);
    this.name = "CardHoldIntentError";
    if (cause) (this as { cause?: unknown }).cause = cause;
  }
}

// The amount the no-show capture will charge. For MVP card-hold rules
// are always a flat amount per booking — partySize is ignored. If
// operators want per-cover holds we'll split the kind.
export function holdAmountMinor(rule: DepositRule, _partySize: number): number {
  if (rule.kind !== "card_hold") {
    throw new CardHoldIntentError("non-card_hold rule in hold path", "wrong-kind");
  }
  return rule.amountMinor;
}

export async function createCardHoldIntent(
  input: CreateCardHoldIntentInput,
): Promise<CreateCardHoldIntentResult> {
  if (paymentsDisabled()) {
    throw new CardHoldIntentError("payments kill-switch engaged", "payments-disabled");
  }

  const amount = holdAmountMinor(input.rule, input.partySize);
  if (amount <= 0) {
    throw new CardHoldIntentError("hold amount resolved to 0", "no-amount");
  }

  const db = adminDb();
  const s = stripe();

  try {
    const customerId = await ensureCustomer(db, s, input);

    const idempotencyKey = `booking_${input.bookingId}_hold_v1`;
    const setup = await s.setupIntents.create(
      {
        customer: customerId,
        payment_method_types: ["card"],
        usage: "off_session",
        payment_method_options: {
          card: { request_three_d_secure: "any" },
        },
        metadata: {
          booking_id: input.bookingId,
          payment_id: input.paymentId,
          organisation_id: input.organisationId,
          kind: "hold",
          // Stash the eventual capture amount in metadata so the
          // no-show capture path doesn't have to re-resolve the rule.
          hold_amount_minor: String(amount),
        },
      },
      { idempotencyKey, stripeAccount: input.stripeAccountId },
    );

    if (!setup.client_secret) {
      throw new CardHoldIntentError("SetupIntent returned no client_secret", "stripe-error");
    }

    await db
      .update(payments)
      .set({
        stripeIntentId: setup.id,
        stripeCustomerId: customerId,
        amountMinor: amount,
        status: setup.status,
      })
      .where(eq(payments.id, input.paymentId));

    await audit.log({
      organisationId: input.organisationId,
      actorUserId: null,
      action: "stripe.setup_intent.created",
      targetType: "payment",
      targetId: input.paymentId,
      metadata: { setupIntentId: setup.id, amountMinor: amount, kind: "hold" },
    });

    return { clientSecret: setup.client_secret, setupIntentId: setup.id, amountMinor: amount };
  } catch (err) {
    if (err instanceof CardHoldIntentError) throw err;
    const message = err instanceof Stripe.errors.StripeError ? err.message : (err as Error).message;
    throw new CardHoldIntentError(message, "stripe-error", err);
  }
}

// Identical to intents.ts#ensureCustomer — duplicated for now since
// the two flows can diverge (e.g. attaching different metadata). If a
// third caller appears, factor out into a shared helper.
async function ensureCustomer(
  db: ReturnType<typeof adminDb>,
  s: Stripe,
  input: CreateCardHoldIntentInput,
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
