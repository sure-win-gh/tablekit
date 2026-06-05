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
import { stripe } from "@/lib/stripe/client";

import { registerHandler } from "../webhook";

async function handle(event: Stripe.Event): Promise<void> {
  const session = event.data.object as Stripe.Checkout.Session;
  if (session.mode !== "subscription") return; // top-ups handled elsewhere
  const subId = typeof session.subscription === "string" ? session.subscription : null;
  if (!subId) return;

  const sub = await stripe().subscriptions.retrieve(subId);
  await syncFromSubscription(sub);
}

registerHandler("checkout.session.completed", handle);

export {};
