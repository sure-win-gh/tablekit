// Singleton Stripe server client.
//
// Every server-side caller goes through stripe() so we construct at
// most once per process. Lazy so tests can flip STRIPE_SECRET_KEY
// between cases without module re-import gymnastics.
//
// The placeholder value baked into .env.local.example ("sk_test_YOUR…")
// is treated as unset — otherwise we'd bring up a running server with
// a broken key and only discover it on the first outbound call. Same
// defensive pattern we use for hCaptcha.

import "server-only";

import Stripe from "stripe";

let _client: Stripe | null = null;

export class StripeNotConfiguredError extends Error {
  constructor() {
    super(
      "lib/stripe/client.ts: STRIPE_SECRET_KEY is not set (or is a placeholder). See .env.local.example.",
    );
    this.name = "StripeNotConfiguredError";
  }
}

function isRealKey(key: string | undefined): key is string {
  if (!key) return false;
  if (key.includes("YOUR_")) return false;
  return key.startsWith("sk_test_") || key.startsWith("sk_live_");
}

export function stripe(): Stripe {
  if (_client) return _client;
  const key = process.env["STRIPE_SECRET_KEY"];
  if (!isRealKey(key)) throw new StripeNotConfiguredError();
  _client = new Stripe(key, { typescript: true });
  return _client;
}

// Exposed so the UI / API can decide whether to offer Stripe actions
// at all. True iff STRIPE_SECRET_KEY is a real-looking sk_test_ or
// sk_live_ value.
export function stripeEnabled(): boolean {
  return isRealKey(process.env["STRIPE_SECRET_KEY"]);
}

// Kill switch per docs/playbooks/payments.md. If set true, every
// Stripe action short-circuits.
export function paymentsDisabled(): boolean {
  return process.env["PAYMENTS_DISABLED"] === "true";
}

// Exported for tests — drop the cached singleton so the next stripe()
// call re-reads env.
export function _resetStripeClientForTests(): void {
  _client = null;
}
