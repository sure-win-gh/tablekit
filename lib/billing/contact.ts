// Read-only billing-contact lookup for the Settings → Account page.
//
// The billing name / email / phone / address / VAT all live on the Stripe
// Customer — collected at Checkout (billing_address_collection: "required",
// customer_update: { address: "auto" }) and edited through the hosted Customer
// Portal. We never store them ourselves, so there's no new PII column or
// migration; this just surfaces what Stripe already holds for display.

import "server-only";

import { eq } from "drizzle-orm";
import type Stripe from "stripe";

import { organisations } from "@/lib/db/schema";
import { isBillingEntity } from "@/lib/regions/mapping";
import { adminDb } from "@/lib/server/admin/db";
import { stripe, stripeEnabled } from "@/lib/stripe/client";

export type BillingContact = {
  name: string | null;
  email: string | null;
  phone: string | null;
  // Address rendered as display lines (street, city, postcode, country),
  // empty when Stripe holds no address.
  addressLines: string[];
  // First tax id (VAT) on the customer, formatted "TYPE VALUE", or null.
  taxId: string | null;
};

// Returns null when billing isn't configured on this environment, when the org
// has never subscribed (no Stripe customer), when the customer was deleted in
// Stripe, or when Stripe is unreachable — all "nothing to show" states the page
// renders as an empty note rather than failing the whole render.
//
// The org→customer lookup runs under adminDb() (RLS bypass), so callers MUST
// pass an `orgId` already authorised for the current session — here that's the
// active-org id from requireRole(). Mirrors lib/billing/portal.ts.
export async function getBillingContact(orgId: string): Promise<BillingContact | null> {
  // Cheap env-only pre-check: on an environment with NO Stripe configured
  // at all (local dev, CI), return the empty state without touching the
  // DB. The per-entity check below still applies once we know the org.
  if (!stripeEnabled("uk") && !stripeEnabled("us")) return null;

  const [org] = await adminDb()
    .select({
      customerId: organisations.stripeCustomerId,
      billingEntity: organisations.billingEntity,
    })
    .from(organisations)
    .where(eq(organisations.id, orgId))
    .limit(1);
  if (!org?.customerId) return null;

  // The customer lives on the org's entity's account. Display-only path:
  // an unknown entity value degrades to the empty state (never falls back
  // to the UK account) rather than failing the whole Account page render.
  if (!isBillingEntity(org.billingEntity)) return null;
  const entity = org.billingEntity;
  if (!stripeEnabled(entity)) return null;

  // Display-only and runs on every Account page load — a Stripe outage should
  // degrade to the empty state, not blank the page (unlike the user-initiated
  // portal/checkout flows, which surface the error).
  let customer: Stripe.Customer | Stripe.DeletedCustomer;
  try {
    customer = await stripe(entity).customers.retrieve(org.customerId, { expand: ["tax_ids"] });
  } catch {
    return null;
  }
  if (customer.deleted) return null;

  const a = customer.address;
  const addressLines = a
    ? [a.line1, a.line2, a.city, a.state, a.postal_code, a.country].filter((l): l is string =>
        Boolean(l),
      )
    : [];

  const tax = customer.tax_ids?.data[0];
  const taxId = tax ? `${tax.type.toUpperCase()} ${tax.value}` : null;

  return {
    name: customer.name ?? null,
    email: customer.email ?? null,
    phone: customer.phone ?? null,
    addressLines,
    taxId,
  };
}
