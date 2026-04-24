// POST /api/stripe/webhook — Stripe event receiver.
//
// Order matters:
//   1. Read the raw body. Stripe's signature is computed over the
//      exact bytes we received; a Next-auto-parsed JSON body would
//      break verification.
//   2. Verify + parse. Bad signature → 400.
//   3. Store (idempotent). Duplicate delivery is fine and Stripe does
//      it often; we no-op.
//   4. Dispatch. Handlers are side-effect-registered via the barrel
//      import below — one line keeps the map populated.
//   5. Always return 200 on a valid signature. Stripe retries on
//      non-2xx for up to 3 days; if we 500 on a handler bug we'll
//      get flooded. Errors get audited + logged, not surfaced.

import { NextResponse, type NextRequest } from "next/server";

import { paymentsDisabled, stripeEnabled } from "@/lib/stripe/client";
import "@/lib/stripe/handlers"; // registers dispatch handlers
import {
  WebhookSecretMissingError,
  WebhookSignatureError,
  dispatch,
  storeEvent,
  verifyAndParse,
} from "@/lib/stripe/webhook";

// Next App Router opts into dynamic by default for route handlers but
// we also need the raw body — req.text() gives it to us intact.
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (!stripeEnabled()) {
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
    event = verifyAndParse(body, signature);
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

  const storeResult = await storeEvent(event);

  try {
    if (storeResult === "new") {
      await dispatch(event);
    }
  } catch (err) {
    // Still 200 so Stripe doesn't retry into a guaranteed failure.
    // The row stays in stripe_events without handled_at set — that's
    // the audit trail. Fix the handler, query for unhandled events,
    // and replay. audit_log is org-scoped, and a webhook-level failure
    // isn't, so we log to console + Sentry (via the Next default).
    console.error("[app/api/stripe/webhook] dispatch failed:", {
      eventId: event.id,
      eventType: event.type,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return NextResponse.json({ ok: true, stored: storeResult }, { status: 200 });
}
