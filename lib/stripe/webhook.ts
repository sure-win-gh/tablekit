// Stripe webhook verification, idempotent storage, and dispatch.
//
// Shape:
//   verifyAndParse(rawBody, signature)   → Stripe.Event  (or throws)
//   storeEvent(event)                    → "new" | "duplicate"
//   dispatch(event)                      → void (runs the registered handler, if any)
//
// Every event — even unknown types — is stored in stripe_events with
// its Stripe evt_* id as the primary key. Idempotent retries from
// Stripe hit the unique constraint and we no-op. Handlers run only
// on the first-time insert so e.g. a duplicate `account.updated`
// doesn't double-audit-log.

import "server-only";

import Stripe from "stripe";
import { sql } from "drizzle-orm";

import { stripeEvents } from "@/lib/db/schema";
import { adminDb } from "@/lib/server/admin/db";

import { stripe } from "./client";

export class WebhookSignatureError extends Error {
  constructor(cause?: unknown) {
    super("lib/stripe/webhook.ts: signature verification failed");
    this.name = "WebhookSignatureError";
    if (cause) (this as { cause?: unknown }).cause = cause;
  }
}

export class WebhookSecretMissingError extends Error {
  constructor() {
    super("lib/stripe/webhook.ts: STRIPE_WEBHOOK_SECRET is not set (or is a placeholder).");
    this.name = "WebhookSecretMissingError";
  }
}

function resolveSecret(): string {
  const secret = process.env["STRIPE_WEBHOOK_SECRET"];
  if (!secret || secret.includes("YOUR_") || !secret.startsWith("whsec_")) {
    throw new WebhookSecretMissingError();
  }
  return secret;
}

export function verifyAndParse(rawBody: string, signature: string | null): Stripe.Event {
  if (!signature) throw new WebhookSignatureError("missing stripe-signature header");
  const secret = resolveSecret();
  try {
    // constructEvent wants Buffer or string; string is fine.
    return stripe().webhooks.constructEvent(rawBody, signature, secret);
  } catch (err) {
    throw new WebhookSignatureError(err);
  }
}

export type StoreResult = "new" | "duplicate";

export async function storeEvent(event: Stripe.Event): Promise<StoreResult> {
  // ON CONFLICT DO NOTHING gives us idempotency without a prior read.
  // If the row already existed, nothing is returned and we know it
  // was a duplicate.
  const db = adminDb();
  const inserted = await db
    .insert(stripeEvents)
    .values({
      id: event.id,
      type: event.type,
      payload: event as unknown as Record<string, unknown>,
    })
    .onConflictDoNothing({ target: stripeEvents.id })
    .returning({ id: stripeEvents.id });
  return inserted.length > 0 ? "new" : "duplicate";
}

// Mark an event as handled. Idempotent — later calls are no-ops.
export async function markHandled(eventId: string): Promise<void> {
  await adminDb()
    .update(stripeEvents)
    .set({ handledAt: sql`now()` })
    .where(sql`${stripeEvents.id} = ${eventId} AND ${stripeEvents.handledAt} IS NULL`);
}

// -----------------------------------------------------------------------------
// Dispatch
// -----------------------------------------------------------------------------

export type HandlerFn = (event: Stripe.Event) => Promise<void>;

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

export async function dispatch(event: Stripe.Event): Promise<"handled" | "no-handler"> {
  const fn = handlers.get(event.type);
  if (!fn) return "no-handler";
  await fn(event);
  await markHandled(event.id);
  return "handled";
}

// Exported for tests that need a clean handler map between cases.
export function _clearHandlersForTests(): void {
  handlers.clear();
}
