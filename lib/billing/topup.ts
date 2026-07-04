// Hosted Stripe Checkout for a one-off messaging-credit top-up.
//
// mode='payment' (not subscription) — the operator pays a fixed amount and
// we credit billing_credit_ledger when the payment confirms (see the
// payment branch of lib/stripe/handlers/billing-checkout.ts). Card entry is
// on Stripe's hosted page → no PCI scope. The amount is fixed server-side
// from a preset list so the client can't post an arbitrary unit_amount.

import "server-only";

import type Stripe from "stripe";

import { currencyForEntity } from "@/lib/regions/mapping";
import { stripe } from "@/lib/stripe/client";

import { appUrl, ensureCustomer } from "./checkout";
import { recordTopup } from "./credit";
import { type TopupAmount } from "./topup-amounts";

// Re-export the client-safe constants/guard so existing server-side imports
// from "@/lib/billing/topup" keep resolving. Client Components must import
// these from "@/lib/billing/topup-amounts" directly (this module is
// server-only).
export { TOPUP_AMOUNTS_PENCE, isTopupAmount, type TopupAmount } from "./topup-amounts";

// Build a payment-mode Checkout Session for a credit top-up. `returnPath`
// is the (relative) dashboard path to come back to — callers pass their
// own page so both owners (billing page) and managers (campaign composer)
// land back where they started.
export async function createTopupCheckout(
  orgId: string,
  amountPence: TopupAmount,
  returnPath: string,
): Promise<string> {
  const { customerId: customer, entity } = await ensureCustomer(orgId);
  const base = appUrl();
  // Only allow returning to an in-app dashboard path (no open redirect).
  const safePath = returnPath.startsWith("/dashboard/") ? returnPath : "/dashboard/organisation";

  const session = await stripe(entity).checkout.sessions.create({
    mode: "payment",
    customer,
    line_items: [
      {
        quantity: 1,
        price_data: {
          // Settlement currency follows the org's entity (uk→GBP, us→USD)
          // — see lib/regions/mapping.ts. Amount presets stay pence/cents
          // agnostic (minor units either way).
          currency: currencyForEntity(entity),
          unit_amount: amountPence,
          // Tax-exclusive: VAT is added on top at checkout (matches the
          // subscription prices).
          tax_behavior: "exclusive",
          product_data: {
            name: "TableKit messaging credit",
            description: "Prepaid SMS/WhatsApp credit (used at cost).",
          },
        },
      },
    ],
    automatic_tax: { enabled: true },
    billing_address_collection: "required",
    customer_update: { address: "auto" },
    // kind distinguishes this from subscription checkouts at the webhook.
    metadata: { organisation_id: orgId, kind: "credit_topup" },
    payment_intent_data: { metadata: { organisation_id: orgId, kind: "credit_topup" } },
    success_url: `${base}${safePath}?topup=success`,
    cancel_url: `${base}${safePath}?topup=cancelled`,
  });

  if (!session.url) throw new Error("lib/billing/topup.ts: Stripe returned no Checkout URL");
  return session.url;
}

// Credit the balance from a completed top-up Checkout Session. Called by
// the checkout.session.completed handler's payment branch. Idempotent on
// the session id (recordTopup → applyEntry → (reason, ref) unique).
export async function creditTopupFromSession(session: Stripe.Checkout.Session): Promise<void> {
  const orgId = session.metadata?.["organisation_id"];
  // Credit the PRE-VAT amount (amount_subtotal). Prices are tax-exclusive, so
  // amount_total includes VAT that goes to HMRC, not to the messaging wallet.
  const amount = session.amount_subtotal;
  if (!orgId || typeof amount !== "number" || amount <= 0) {
    console.warn("[lib/billing/topup.ts] top-up session missing org/amount; skipping", {
      sessionId: session.id,
    });
    return;
  }
  await recordTopup(orgId, amount, session.id);
}
