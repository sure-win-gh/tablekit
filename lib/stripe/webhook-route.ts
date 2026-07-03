// Shared POST handler for the per-entity Stripe webhook routes
// (docs/specs/multi-region.md, Phase 2). The route files under
// app/api/stripe/webhook/** are one-liners over this factory:
//
//   /api/stripe/webhook     → uk (legacy alias — keep live until the
//                             Stripe dashboard endpoint is repointed
//                             to /uk and verified)
//   /api/stripe/webhook/uk  → uk
//   /api/stripe/webhook/us  → us
//
// Order matters:
//   1. Read the raw body. Stripe's signature is computed over the
//      exact bytes we received; a Next-auto-parsed JSON body would
//      break verification.
//   2. Verify + parse against THIS entity's signing secret. Bad
//      signature → 400.
//   3. Store (idempotent, keyed by (entity, evt id)). Duplicate
//      delivery is fine and Stripe does it often; we no-op.
//   4. Dispatch, passing the entity so handlers call back into the
//      same Stripe account.
//   5. Always return 200 on a valid signature. Stripe retries on
//      non-2xx for up to 3 days; if we 500 on a handler bug we'll
//      get flooded. Errors get audited + logged, not surfaced.

import "server-only";

import { NextResponse, type NextRequest } from "next/server";

import type { BillingEntity } from "@/lib/regions/mapping";
import { paymentsDisabled, stripeEnabled } from "@/lib/stripe/client";
import "@/lib/stripe/handlers"; // registers dispatch handlers
import {
  WebhookSecretMissingError,
  WebhookSignatureError,
  dispatch,
  storeEvent,
  verifyAndParse,
} from "@/lib/stripe/webhook";

export function makeStripeWebhookHandler(
  entity: BillingEntity,
): (req: NextRequest) => Promise<NextResponse> {
  return async function POST(req: NextRequest): Promise<NextResponse> {
    if (!stripeEnabled(entity)) {
      return NextResponse.json({ error: "stripe-not-configured" }, { status: 503 });
    }
    if (paymentsDisabled()) {
      // Kill switch — accept the event so Stripe doesn't retry, but
      // don't process.
      return NextResponse.json({ ok: true, skipped: "payments-disabled" }, { status: 200 });
    }

    const body = await req.text();
    const signature = req.headers.get("stripe-signature");

    let event;
    try {
      event = verifyAndParse(body, signature, entity);
    } catch (err) {
      if (err instanceof WebhookSecretMissingError) {
        // Server-side misconfiguration, not the caller's fault.
        return NextResponse.json({ error: "server-misconfigured" }, { status: 500 });
      }
      if (err instanceof WebhookSignatureError) {
        return NextResponse.json({ error: "bad-signature" }, { status: 400 });
      }
      throw err;
    }

    const storeResult = await storeEvent(event, entity);

    try {
      if (storeResult === "new") {
        await dispatch(event, entity);
      }
    } catch (err) {
      // Still 200 so Stripe doesn't retry into a guaranteed failure.
      // The row stays in stripe_events without handled_at set — that's
      // the audit trail. Fix the handler, query for unhandled events,
      // and replay. audit_log is org-scoped, and a webhook-level failure
      // isn't, so we log to console + Sentry (via the Next default).
      console.error("[lib/stripe/webhook-route] dispatch failed:", {
        eventId: event.id,
        eventType: event.type,
        entity,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return NextResponse.json({ ok: true, stored: storeResult }, { status: 200 });
  };
}
