// Hosted Stripe Checkout for the platform-account subscription.
//
// Tablekit is the merchant here (NOT Connect — that's deposits, where the
// venue is the merchant). We create at most one platform Customer per org
// (idempotency-keyed), then a subscription-mode Checkout Session carrying
// the flat plan price (+ the metered usage price once configured). Card
// entry happens entirely on Stripe's hosted page → no PCI scope for us.
//
// We DO NOT change organisations.plan here. The plan flips only when the
// resulting subscription webhook fires (lib/billing/subscription.ts), so a
// user who reaches the success URL without paying can't self-upgrade.
// See docs/specs/stripe-billing.md + docs/playbooks/payments.md.

import "server-only";

import { eq } from "drizzle-orm";

import { organisations } from "@/lib/db/schema";
import { assertBillingEntity } from "@/lib/regions/mapping";
import { adminDb } from "@/lib/server/admin/db";
import { stripe } from "@/lib/stripe/client";

import { entityForOrg } from "./entity";
import { optionalUsagePriceId, type PaidPlan, priceIdForPlan } from "./plans";

export function appUrl(): string {
  const url = process.env["NEXT_PUBLIC_APP_URL"];
  if (!url) throw new Error("lib/billing/checkout.ts: NEXT_PUBLIC_APP_URL is not set.");
  return url.replace(/\/$/, "");
}

// Ensure the org has a platform Stripe Customer, creating one on first use.
// The idempotency key is per-org + versioned so a network retry can never
// create a second customer for the same org (and two concurrent checkouts
// both racing here converge on the same customer for the same reason).
// Exported so the credit top-up flow reuses the one-customer-per-org rule.
export async function ensureCustomer(orgId: string): Promise<string> {
  const db = adminDb();
  const [org] = await db
    .select({
      name: organisations.name,
      customerId: organisations.stripeCustomerId,
      billingEntity: organisations.billingEntity,
    })
    .from(organisations)
    .where(eq(organisations.id, orgId))
    .limit(1);
  if (!org) throw new Error(`lib/billing/checkout.ts: org ${orgId} not found`);
  if (org.customerId) return org.customerId;

  // The Customer is created on the ORG'S ENTITY'S account — this is the
  // moment an org's billing gets pinned to a Stripe account, and it is
  // not portable afterwards (customers/subscriptions can't move between
  // accounts — docs/specs/multi-region.md D7). Unknown value → throw,
  // never default (same fail-closed rule as entityForOrg).
  const entity = assertBillingEntity(org.billingEntity);
  const customer = await stripe(entity).customers.create(
    { name: org.name, metadata: { organisation_id: orgId } },
    { idempotencyKey: `org_${orgId}_billing_customer_v1` },
  );
  await db
    .update(organisations)
    .set({ stripeCustomerId: customer.id })
    .where(eq(organisations.id, orgId));
  return customer.id;
}

export async function createSubscriptionCheckout(
  orgId: string,
  targetPlan: PaidPlan,
): Promise<string> {
  const entity = await entityForOrg(orgId);
  const customer = await ensureCustomer(orgId);

  const lineItems: { price: string; quantity?: number }[] = [
    { price: priceIdForPlan(targetPlan, entity), quantity: 1 },
  ];
  // Attach the metered usage price so transactional sends can be reported
  // against it (PR-3). Omitted until the Meter/price is configured.
  const usage = optionalUsagePriceId(entity);
  if (usage) lineItems.push({ price: usage });

  const base = appUrl();
  const session = await stripe(entity).checkout.sessions.create({
    mode: "subscription",
    customer,
    line_items: lineItems,
    // VAT is added on top of our tax-exclusive prices, computed by Stripe
    // Tax from the billing address (collected here + saved to the customer
    // so renewals keep computing it). The subscription inherits this, so
    // Portal-initiated changes + recurring invoices stay tax-correct.
    automatic_tax: { enabled: true },
    billing_address_collection: "required",
    customer_update: { address: "auto" },
    // organisation_id on BOTH the session and the subscription so the
    // webhook can resolve the org from either event.
    metadata: { organisation_id: orgId },
    subscription_data: { metadata: { organisation_id: orgId } },
    success_url: `${base}/dashboard/organisation/billing?checkout=success`,
    cancel_url: `${base}/dashboard/organisation/billing?checkout=cancelled`,
  });

  if (!session.url) throw new Error("lib/billing/checkout.ts: Stripe returned no Checkout URL");
  return session.url;
}
