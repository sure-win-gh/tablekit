// Webhook handlers: invoice.paid | invoice.payment_failed.
//
// These are for the audit trail + dunning visibility. We DON'T flip the
// plan here — that's driven by the customer.subscription.updated event
// Stripe sends alongside (active ↔ past_due ↔ canceled). The past-due
// banner reads billing_subscriptions.status, which the subscription
// handler keeps current.

import "server-only";

import type Stripe from "stripe";
import { eq } from "drizzle-orm";

import { organisations } from "@/lib/db/schema";
import { audit } from "@/lib/server/admin/audit";
import { adminDb } from "@/lib/server/admin/db";

import { registerHandler } from "../webhook";

function customerIdOf(invoice: Stripe.Invoice): string | null {
  return typeof invoice.customer === "string" ? invoice.customer : (invoice.customer?.id ?? null);
}

async function orgIdForCustomer(customerId: string | null): Promise<string | null> {
  if (!customerId) return null;
  const [row] = await adminDb()
    .select({ id: organisations.id })
    .from(organisations)
    .where(eq(organisations.stripeCustomerId, customerId))
    .limit(1);
  return row?.id ?? null;
}

function makeHandler(action: "billing.invoice.paid" | "billing.invoice.payment_failed") {
  return async (event: Stripe.Event): Promise<void> => {
    const invoice = event.data.object as Stripe.Invoice;
    const orgId = await orgIdForCustomer(customerIdOf(invoice));
    if (!orgId) {
      // No matching org (e.g. a Connect invoice, or a customer we don't
      // track). Nothing to audit at org scope — log and move on.
      console.warn("[lib/stripe/handlers/billing-invoice.ts] no org for invoice", {
        invoiceId: invoice.id,
        action,
      });
      return;
    }
    await audit.log({
      organisationId: orgId,
      actorUserId: null,
      action,
      targetType: "organisation",
      targetId: orgId,
      metadata: {
        invoiceId: invoice.id,
        amountDue: invoice.amount_due,
        amountPaid: invoice.amount_paid,
      },
    });
  };
}

registerHandler("invoice.paid", makeHandler("billing.invoice.paid"));
registerHandler("invoice.payment_failed", makeHandler("billing.invoice.payment_failed"));

export {};
