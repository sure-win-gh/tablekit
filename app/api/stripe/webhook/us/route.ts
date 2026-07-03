// POST /api/stripe/webhook/us — US entity's Stripe event receiver.
// Returns 503 until STRIPE_SECRET_KEY_US is configured (Phase 4 bring-up);
// the signing secret is STRIPE_WEBHOOK_SECRET_US — no fallback to the UK
// secret, by design. See lib/stripe/webhook-route.ts.

import { makeStripeWebhookHandler } from "@/lib/stripe/webhook-route";

export const dynamic = "force-dynamic";

export const POST = makeStripeWebhookHandler("us");
