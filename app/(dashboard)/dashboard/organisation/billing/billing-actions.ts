"use server";

import { redirect } from "next/navigation";

import { requireRole } from "@/lib/auth/require-role";
import { createSubscriptionCheckout } from "@/lib/billing/checkout";
import { type PaidPlan } from "@/lib/billing/plans";
import { createPortalSession } from "@/lib/billing/portal";
import { audit } from "@/lib/server/admin/audit";

// Billing actions are OWNER-ONLY (requireRole throws below for anyone
// less). Each just mints a hosted Stripe URL and redirects there — no
// card data, no plan mutation here (the plan flips only via the webhook).

// Bound to a plan in the page: startCheckout.bind(null, "core").
export async function startCheckout(plan: PaidPlan, _formData: FormData): Promise<void> {
  const { orgId, userId } = await requireRole("owner");
  await audit.log({
    organisationId: orgId,
    actorUserId: userId,
    action: "billing.checkout.started",
    targetType: "organisation",
    targetId: orgId,
    metadata: { plan },
  });
  const url = await createSubscriptionCheckout(orgId, plan);
  redirect(url);
}

export async function openPortal(_formData: FormData): Promise<void> {
  const { orgId } = await requireRole("owner");
  const url = await createPortalSession(orgId);
  redirect(url);
}
