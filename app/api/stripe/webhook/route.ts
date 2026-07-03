// POST /api/stripe/webhook — LEGACY ALIAS for the UK entity's receiver.
//
// The Stripe dashboard's webhook endpoint still points here. Keep this
// route live until it is repointed to /api/stripe/webhook/uk and a real
// event has been observed arriving there (docs/specs/multi-region.md,
// Phase 2 cutover note). Then delete this file.
//
// See lib/stripe/webhook-route.ts for the shared handler + ordering notes.

import { makeStripeWebhookHandler } from "@/lib/stripe/webhook-route";

export const dynamic = "force-dynamic";

export const POST = makeStripeWebhookHandler("uk");
