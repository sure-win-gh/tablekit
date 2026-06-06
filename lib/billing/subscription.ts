// Reconcile a Stripe subscription into our DB.
//
// syncFromSubscription is the ONLY path that mutates organisations.plan
// for billing reasons. Both the subscription webhook handlers and the
// checkout-completed handler funnel through here, so plan state is always
// derived from Stripe — never set optimistically by the Checkout success
// redirect (which an attacker could hit without paying). It:
//   1. resolves the org (sub.metadata.organisation_id, else by customer id)
//   2. derives the entitled plan from the subscription's status + price
//   3. upserts billing_subscriptions (keyed on organisation_id)
//   4. writes organisations.plan (+ backfills stripe_customer_id)
//
// Idempotent: re-running for the same subscription state is a no-op write.
// See docs/specs/stripe-billing.md.

import "server-only";

import type Stripe from "stripe";
import { eq } from "drizzle-orm";

import type { Plan } from "@/lib/auth/plan-level";
import { billingSubscriptions, organisations } from "@/lib/db/schema";
import { audit } from "@/lib/server/admin/audit";
import { adminDb } from "@/lib/server/admin/db";

import { type PaidPlan, planFromPriceId } from "./plans";

// Statuses that grant access. past_due keeps access while Stripe dunns —
// we only drop them once the subscription is actually terminated.
const ENTITLED = new Set<Stripe.Subscription.Status>(["active", "trialing", "past_due"]);
// Statuses that end access for good. NOTE: 'paused' is deliberately NOT
// here — it's a recoverable state (trial-without-payment-method pause /
// pause-collection) that resumes via subscription.updated(active), so we
// leave the plan unchanged rather than silently revoke a paying customer.
// Matches the spec's mapping (canceled|unpaid|incomplete_expired → free).
const TERMINAL = new Set<Stripe.Subscription.Status>(["canceled", "unpaid", "incomplete_expired"]);

function customerIdOf(sub: Stripe.Subscription): string | null {
  return typeof sub.customer === "string" ? sub.customer : (sub.customer?.id ?? null);
}

// The paid plan the subscription's flat price maps to (first matching
// line item). Null if only the usage price / an unknown price is present.
// Exported for unit testing.
export function planFromSubscription(sub: Stripe.Subscription): PaidPlan | null {
  for (const item of sub.items?.data ?? []) {
    const p = planFromPriceId(item.price.id);
    if (p) return p;
  }
  return null;
}

// current_period_end moved onto the subscription ITEM in the 2025 Stripe
// API (SDK v22) — read it from the first item. Exported for unit testing.
export function periodEndOf(sub: Stripe.Subscription): Date | null {
  const secs = sub.items?.data?.[0]?.current_period_end;
  return typeof secs === "number" ? new Date(secs * 1000) : null;
}

// Returns the org plan this subscription state implies, or null to leave
// the org's current plan untouched (e.g. 'incomplete' — payment not yet
// confirmed, so no entitlement granted and nothing to revoke). Exported
// for unit testing.
export function deriveOrgPlan(
  status: Stripe.Subscription.Status,
  subPlan: PaidPlan | null,
): Plan | null {
  if (TERMINAL.has(status)) return "free";
  if (ENTITLED.has(status)) return subPlan; // null → leave unchanged (logged by caller)
  return null;
}

export class OrgResolutionError extends Error {
  constructor(subId: string) {
    super(`syncFromSubscription: could not resolve an organisation for subscription ${subId}`);
    this.name = "OrgResolutionError";
  }
}

async function resolveOrgId(sub: Stripe.Subscription): Promise<string | null> {
  // Trust boundary: this only runs on signature-verified PLATFORM webhook
  // events, and organisation_id is metadata WE set at Checkout. The only
  // way to forge it is Stripe-dashboard access (i.e. us). If that ever
  // widens, assert the metadata org's stored stripe_customer_id matches
  // customerIdOf(sub) before trusting it.
  const fromMeta = sub.metadata?.["organisation_id"];
  if (typeof fromMeta === "string" && fromMeta.length > 0) return fromMeta;

  // Fallback: a subscription created/edited outside our Checkout (e.g. in
  // the Stripe dashboard) may lack our metadata. Match on the customer id
  // we stored when the customer was created.
  const customerId = customerIdOf(sub);
  if (!customerId) return null;
  const [row] = await adminDb()
    .select({ id: organisations.id })
    .from(organisations)
    .where(eq(organisations.stripeCustomerId, customerId))
    .limit(1);
  return row?.id ?? null;
}

export async function syncFromSubscription(sub: Stripe.Subscription): Promise<void> {
  const db = adminDb();

  const orgId = await resolveOrgId(sub);
  if (!orgId) {
    // No org → nothing we can do. Throwing surfaces in the webhook's
    // catch (which 200s + logs) rather than silently dropping money state.
    throw new OrgResolutionError(sub.id);
  }

  const subPlan = planFromSubscription(sub);
  const orgPlan = deriveOrgPlan(sub.status, subPlan);
  const customerId = customerIdOf(sub);

  // Record the subscription. We need a non-null plan for the row; prefer
  // the resolved price, else keep the plan already stored for this sub.
  // Only skip the row write if we can resolve neither (logged).
  let rowPlan: PaidPlan | null = subPlan;
  if (!rowPlan) {
    const [existing] = await db
      .select({ plan: billingSubscriptions.plan })
      .from(billingSubscriptions)
      .where(eq(billingSubscriptions.stripeSubscriptionId, sub.id))
      .limit(1);
    rowPlan = (existing?.plan as PaidPlan | undefined) ?? null;
  }

  if (rowPlan) {
    await db
      .insert(billingSubscriptions)
      .values({
        organisationId: orgId,
        stripeSubscriptionId: sub.id,
        status: sub.status,
        plan: rowPlan,
        currentPeriodEnd: periodEndOf(sub),
        cancelAtPeriodEnd: sub.cancel_at_period_end ?? false,
      })
      .onConflictDoUpdate({
        target: billingSubscriptions.organisationId,
        set: {
          stripeSubscriptionId: sub.id,
          status: sub.status,
          plan: rowPlan,
          currentPeriodEnd: periodEndOf(sub),
          cancelAtPeriodEnd: sub.cancel_at_period_end ?? false,
        },
      });
  } else {
    console.warn("[lib/billing/subscription.ts] no plan price on subscription; skipping row", {
      subscriptionId: sub.id,
      status: sub.status,
    });
  }

  // Update the org: plan (when the status dictates one) + backfill the
  // customer id if we didn't have it yet.
  const orgUpdate: { plan?: Plan; stripeCustomerId?: string } = {};
  if (orgPlan) orgUpdate.plan = orgPlan;
  if (customerId) orgUpdate.stripeCustomerId = customerId;
  if (orgPlan === null && ENTITLED.has(sub.status) && !subPlan) {
    console.warn("[lib/billing/subscription.ts] entitled subscription without a known plan price", {
      subscriptionId: sub.id,
      status: sub.status,
    });
  }
  if (Object.keys(orgUpdate).length > 0) {
    await db.update(organisations).set(orgUpdate).where(eq(organisations.id, orgId));
  }

  await audit.log({
    organisationId: orgId,
    actorUserId: null,
    action: "billing.subscription.synced",
    targetType: "organisation",
    targetId: orgId,
    metadata: {
      subscriptionId: sub.id,
      status: sub.status,
      plan: orgPlan ?? "(unchanged)",
      cancelAtPeriodEnd: sub.cancel_at_period_end ?? false,
    },
  });
}
