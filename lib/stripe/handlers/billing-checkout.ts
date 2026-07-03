// Webhook handler: checkout.session.completed (subscription mode only).
//
// Fires when an operator finishes hosted Checkout for a plan upgrade. We
// retrieve the freshly-created subscription and sync it (which sets the
// plan).
//
// NOTE: the dispatch registry holds ONE handler per event type, so this
// is the single checkout.session.completed handler. PR-2's credit top-up
// (mode='payment') extends THIS function with a payment branch — it must
// not register the event separately or it would clobber this handler.
//
// Belt-and-braces: customer.subscription.created usually arrives too, so
// this is partly redundant, but handling it here means the plan is live
// the instant the user lands back even if the subscription event lags.

import "server-only";

import type Stripe from "stripe";

import { syncFromSubscription } from "@/lib/billing/subscription";
import { creditTopupFromSession } from "@/lib/billing/topup";
import type { BillingEntity } from "@/lib/regions/mapping";
import { stripe } from "@/lib/stripe/client";

import { registerHandler } from "../webhook";

async function handle(event: Stripe.Event, entity: BillingEntity): Promise<void> {
  const session = event.data.object as Stripe.Checkout.Session;

  // Payment-mode session with our top-up marker → credit the balance.
  if (session.mode === "payment") {
    if (session.metadata?.["kind"] === "credit_topup") await creditTopupFromSession(session);
    return;
  }

  // Subscription-mode session → sync the new subscription (sets the plan).
  if (session.mode !== "subscription") return;
  const subId = typeof session.subscription === "string" ? session.subscription : null;
  if (!subId) return;

  // Retrieve from the SAME entity's account that delivered the event —
  // the subscription doesn't exist on the other one.
  const sub = await stripe(entity).subscriptions.retrieve(subId);
  await syncFromSubscription(sub);
}

registerHandler("checkout.session.completed", handle);

export {};
