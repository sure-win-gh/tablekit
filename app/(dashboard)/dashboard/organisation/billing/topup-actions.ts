"use server";

import { redirect } from "next/navigation";
import { z } from "zod";

import { requirePlan } from "@/lib/auth/require-plan";
import { requireRole } from "@/lib/auth/require-role";
import { createTopupCheckout, isTopupAmount } from "@/lib/billing/topup";

// Buy prepaid messaging credit. Manager+ (owners qualify too) — both the
// owner billing page and the manager-facing campaign composer use this, so
// a manager who's short on credit can self-serve a top-up. Redirects to
// hosted Checkout; the balance is credited by the webhook on payment.
//
// Plus-gated: credit only funds marketing campaigns (a Plus feature), so a
// Free/Core org has nothing to spend it on. requirePlan is the server-side
// guard behind the UI (the composer is already Plus-locked; the billing
// page only shows top-up to Plus orgs).
//
// Bound to an amount in the page: startTopup.bind(null, 2000). `return_to`
// (relative dashboard path) sends the operator back where they started.
export async function startTopup(amountPence: number, formData: FormData): Promise<void> {
  const { orgId } = await requireRole("manager");
  await requirePlan(orgId, "plus");
  if (!isTopupAmount(amountPence)) throw new Error("startTopup: invalid amount");

  const returnTo = z.string().safeParse(formData.get("return_to"));
  const path =
    returnTo.success && returnTo.data.startsWith("/dashboard/")
      ? returnTo.data
      : "/dashboard/organisation/billing";

  const url = await createTopupCheckout(orgId, amountPence, path);
  redirect(url);
}
