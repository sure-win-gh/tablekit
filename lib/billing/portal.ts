// Hosted Stripe Customer Portal session.
//
// The Portal is where operators change their card, switch Core↔Plus, or
// cancel — all on Stripe's hosted UI, so no card data touches us. Plan
// changes made here still flow back through the subscription webhook
// (lib/billing/subscription.ts), keeping organisations.plan authoritative.

import "server-only";

import { eq } from "drizzle-orm";

import { organisations } from "@/lib/db/schema";
import { assertBillingEntity } from "@/lib/regions/mapping";
import { adminDb } from "@/lib/server/admin/db";
import { stripe } from "@/lib/stripe/client";

export class NoBillingCustomerError extends Error {
  constructor(orgId: string) {
    super(`lib/billing/portal.ts: org ${orgId} has no Stripe customer yet (subscribe first)`);
    this.name = "NoBillingCustomerError";
  }
}

// Fail fast on a missing app URL rather than minting a relative return_url
// that Stripe rejects at runtime (mirrors lib/billing/checkout.ts).
function appUrl(): string {
  const url = process.env["NEXT_PUBLIC_APP_URL"];
  if (!url) throw new Error("lib/billing/portal.ts: NEXT_PUBLIC_APP_URL is not set.");
  return url.replace(/\/$/, "");
}

export async function createPortalSession(orgId: string): Promise<string> {
  const [org] = await adminDb()
    .select({
      customerId: organisations.stripeCustomerId,
      billingEntity: organisations.billingEntity,
    })
    .from(organisations)
    .where(eq(organisations.id, orgId))
    .limit(1);
  if (!org?.customerId) throw new NoBillingCustomerError(orgId);

  // The customer lives on the org's entity's account — a portal session
  // minted on the wrong account would 404 the customer. Unknown value →
  // throw (fail closed), never default to the UK account.
  const entity = assertBillingEntity(org.billingEntity);
  const session = await stripe(entity).billingPortal.sessions.create({
    customer: org.customerId,
    return_url: `${appUrl()}/dashboard/organisation/billing`,
  });
  return session.url;
}
