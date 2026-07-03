// POST /api/stripe/webhook/uk — UK entity's Stripe event receiver.
// See lib/stripe/webhook-route.ts for the shared handler + ordering notes.

import { makeStripeWebhookHandler } from "@/lib/stripe/webhook-route";

export const dynamic = "force-dynamic";

export const POST = makeStripeWebhookHandler("uk");
