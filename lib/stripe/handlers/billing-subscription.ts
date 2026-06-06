// Webhook handlers: customer.subscription.created | updated | deleted.
//
// Platform-account events (Tablekit = merchant). Each just funnels the
// subscription object through syncFromSubscription, which is the single
// writer of organisations.plan. Covers upgrades, Portal plan switches,
// dunning (→ past_due), and cancellation (→ deleted → free).
//
// Idempotent: the webhook route only dispatches first-delivery events
// (stripe_events), and syncFromSubscription is itself a no-op re-write.

import "server-only";

import type Stripe from "stripe";

import { syncFromSubscription } from "@/lib/billing/subscription";

import { registerHandler } from "../webhook";

async function handle(event: Stripe.Event): Promise<void> {
  await syncFromSubscription(event.data.object as Stripe.Subscription);
}

registerHandler("customer.subscription.created", handle);
registerHandler("customer.subscription.updated", handle);
registerHandler("customer.subscription.deleted", handle);

export {};
