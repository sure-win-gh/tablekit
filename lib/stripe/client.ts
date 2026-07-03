// Entity-keyed Stripe server clients (docs/specs/multi-region.md, Phase 2).
//
// Two legal entities, two Stripe accounts:
//   uk — the existing UK entity. Key read from STRIPE_SECRET_KEY_UK,
//        falling back to the legacy STRIPE_SECRET_KEY so the current
//        deployment keeps working untouched (alias pattern).
//   us — the US entity (Phase 4). STRIPE_SECRET_KEY_US only. Unset =
//        FAILS CLOSED: a wrong-entity call must throw, never silently
//        fall back to the other entity's account.
//
// At most one client per entity per process. Lazy so tests can flip the
// env between cases without module re-import gymnastics.
//
// The placeholder value baked into .env.local.example ("sk_test_YOUR…")
// is treated as unset — otherwise we'd bring up a running server with
// a broken key and only discover it on the first outbound call. Same
// defensive pattern we use for hCaptcha.

import "server-only";

import Stripe from "stripe";

import { DEFAULT_BILLING_ENTITY, type BillingEntity } from "@/lib/regions/mapping";

const _clients = new Map<BillingEntity, Stripe>();

export class StripeNotConfiguredError extends Error {
  constructor(entity: BillingEntity) {
    super(
      `lib/stripe/client.ts: no Stripe secret key configured for entity "${entity}" — ` +
        `set ${entity === "uk" ? "STRIPE_SECRET_KEY_UK (or legacy STRIPE_SECRET_KEY)" : "STRIPE_SECRET_KEY_US"}. ` +
        "See .env.local.example.",
    );
    this.name = "StripeNotConfiguredError";
  }
}

function isRealKey(key: string | undefined): key is string {
  if (!key) return false;
  if (key.includes("YOUR_")) return false;
  return key.startsWith("sk_test_") || key.startsWith("sk_live_");
}

function secretKeyFor(entity: BillingEntity): string | null {
  // uk falls back to the legacy env name; us NEVER falls back (fail closed).
  const candidates =
    entity === "uk" ? ["STRIPE_SECRET_KEY_UK", "STRIPE_SECRET_KEY"] : ["STRIPE_SECRET_KEY_US"];
  for (const name of candidates) {
    const key = process.env[name];
    if (isRealKey(key)) return key;
  }
  return null;
}

export function stripe(entity: BillingEntity = DEFAULT_BILLING_ENTITY): Stripe {
  const cached = _clients.get(entity);
  if (cached) return cached;
  const key = secretKeyFor(entity);
  if (!key) throw new StripeNotConfiguredError(entity);
  const client = new Stripe(key, { typescript: true });
  _clients.set(entity, client);
  return client;
}

// Exposed so the UI / API can decide whether to offer Stripe actions
// at all. True iff the entity resolves a real-looking sk_test_ or
// sk_live_ value.
export function stripeEnabled(entity: BillingEntity = DEFAULT_BILLING_ENTITY): boolean {
  return secretKeyFor(entity) !== null;
}

// Kill switch per docs/playbooks/payments.md. If set true, every
// Stripe action short-circuits — deliberately global across entities
// (an incident isn't the moment to reason about which account).
export function paymentsDisabled(): boolean {
  return process.env["PAYMENTS_DISABLED"] === "true";
}

// Exported for tests — drop the cached clients so the next stripe()
// call re-reads env.
export function _resetStripeClientForTests(): void {
  _clients.clear();
}
