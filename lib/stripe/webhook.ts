// Stripe webhook verification, idempotent storage, and dispatch —
// entity-keyed (docs/specs/multi-region.md, Phase 2).
//
// Shape:
//   verifyAndParse(rawBody, signature, entity) → Stripe.Event  (or throws)
//   storeEvent(event, entity)                  → "new" | "duplicate"
//   dispatch(event, entity)                    → void (runs the registered handler, if any)
//
// Each entity's Stripe account has its own webhook endpoint + signing
// secret: uk reads STRIPE_WEBHOOK_SECRET_UK falling back to the legacy
// STRIPE_WEBHOOK_SECRET; us reads STRIPE_WEBHOOK_SECRET_US only (fail
// closed — a signature must never verify against the other entity's
// secret).
//
// Every event — even unknown types — is stored in stripe_events keyed by
// (entity, evt_* id). evt ids are only unique PER ACCOUNT, so the entity
// is part of the dedup key. Idempotent retries from Stripe hit the unique
// constraint and we no-op. Handlers run only on the first-time insert so
// e.g. a duplicate `account.updated` doesn't double-audit-log.

import "server-only";

import Stripe from "stripe";
import { and, sql } from "drizzle-orm";

import { stripeEvents } from "@/lib/db/schema";
import { DEFAULT_BILLING_ENTITY, type BillingEntity } from "@/lib/regions/mapping";
import { adminDb } from "@/lib/server/admin/db";

import { stripe } from "./client";

export class WebhookSignatureError extends Error {
  // `reason` is a fixed, developer-authored string only — never the raw
  // upstream error. Stripe's verification error carries the raw request
  // payload (guest PII), and chaining it via `cause` would leak that into
  // Sentry / console when the error serialises. See gdpr.md §Logs
  // ("no error chaining").
  constructor(reason?: string) {
    super(`lib/stripe/webhook.ts: signature verification failed${reason ? ` (${reason})` : ""}`);
    this.name = "WebhookSignatureError";
  }
}

export class WebhookSecretMissingError extends Error {
  constructor(entity: BillingEntity) {
    super(
      `lib/stripe/webhook.ts: no webhook secret configured for entity "${entity}" — set ` +
        `${entity === "uk" ? "STRIPE_WEBHOOK_SECRET_UK (or legacy STRIPE_WEBHOOK_SECRET)" : "STRIPE_WEBHOOK_SECRET_US"}.`,
    );
    this.name = "WebhookSecretMissingError";
  }
}

function isRealSecret(v: string | undefined): v is string {
  return Boolean(v && !v.includes("YOUR_") && v.startsWith("whsec_"));
}

function resolveSecret(entity: BillingEntity): string {
  // uk falls back to the legacy env name; us NEVER falls back.
  const candidates =
    entity === "uk"
      ? ["STRIPE_WEBHOOK_SECRET_UK", "STRIPE_WEBHOOK_SECRET"]
      : ["STRIPE_WEBHOOK_SECRET_US"];
  for (const name of candidates) {
    const secret = process.env[name];
    if (isRealSecret(secret)) return secret;
  }
  throw new WebhookSecretMissingError(entity);
}

export function verifyAndParse(
  rawBody: string,
  signature: string | null,
  entity: BillingEntity = DEFAULT_BILLING_ENTITY,
): Stripe.Event {
  if (!signature) throw new WebhookSignatureError("missing stripe-signature header");
  const secret = resolveSecret(entity);
  try {
    // constructEvent wants Buffer or string; string is fine.
    return stripe(entity).webhooks.constructEvent(rawBody, signature, secret);
  } catch {
    // constructEvent rejected: bad signature or timestamp outside
    // tolerance. Deliberately drop the raw error (see class comment).
    throw new WebhookSignatureError("constructEvent rejected");
  }
}

export type StoreResult = "new" | "duplicate";

export async function storeEvent(
  event: Stripe.Event,
  entity: BillingEntity = DEFAULT_BILLING_ENTITY,
): Promise<StoreResult> {
  // ON CONFLICT DO NOTHING gives us idempotency without a prior read.
  // If the row already existed, nothing is returned and we know it
  // was a duplicate.
  const db = adminDb();
  const inserted = await db
    .insert(stripeEvents)
    .values({
      id: event.id,
      entity,
      type: event.type,
      payload: event as unknown as Record<string, unknown>,
    })
    .onConflictDoNothing({ target: [stripeEvents.entity, stripeEvents.id] })
    .returning({ id: stripeEvents.id });
  return inserted.length > 0 ? "new" : "duplicate";
}

// Mark an event as handled. Idempotent — later calls are no-ops.
export async function markHandled(
  eventId: string,
  entity: BillingEntity = DEFAULT_BILLING_ENTITY,
): Promise<void> {
  await adminDb()
    .update(stripeEvents)
    .set({ handledAt: sql`now()` })
    .where(
      and(
        sql`${stripeEvents.id} = ${eventId}`,
        sql`${stripeEvents.entity} = ${entity}`,
        sql`${stripeEvents.handledAt} IS NULL`,
      ),
    );
}

// -----------------------------------------------------------------------------
// Dispatch
// -----------------------------------------------------------------------------

// Handlers receive the entity whose account delivered the event so any
// follow-up Stripe API call (e.g. billing-checkout retrieving the new
// subscription) hits the SAME account. Handlers that don't call back into
// Stripe can simply ignore the second parameter.
export type HandlerFn = (event: Stripe.Event, entity: BillingEntity) => Promise<void>;

// Only handlers we've wired up land here. New handlers register via
// lib/stripe/handlers/<type>.ts and import into webhook.ts — see
// `payments-connect` phase plan for ordering.
const handlers = new Map<string, HandlerFn>();

export function registerHandler(eventType: string, fn: HandlerFn): void {
  handlers.set(eventType, fn);
}

export function getHandler(eventType: string): HandlerFn | undefined {
  return handlers.get(eventType);
}

export async function dispatch(
  event: Stripe.Event,
  entity: BillingEntity = DEFAULT_BILLING_ENTITY,
): Promise<"handled" | "no-handler"> {
  const fn = handlers.get(event.type);
  if (!fn) return "no-handler";
  await fn(event, entity);
  await markHandled(event.id, entity);
  return "handled";
}

// Exported for tests that need a clean handler map between cases.
export function _clearHandlersForTests(): void {
  handlers.clear();
}
