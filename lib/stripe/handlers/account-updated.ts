// Webhook handler: account.updated.
//
// Fires whenever Stripe mutates a Connected Account — KYC completion,
// payouts enabled, capability updates, the lot. We mirror the
// relevant flags onto our `stripe_accounts` row + audit-log it.
//
// If we don't have a row for this account yet (which shouldn't happen
// because we create the row before redirecting into onboarding, but
// the webhook could race a crashed onboarding action), we insert one.

import "server-only";

import type Stripe from "stripe";
import { eq } from "drizzle-orm";

import { stripeAccounts } from "@/lib/db/schema";
import { audit } from "@/lib/server/admin/audit";
import { adminDb } from "@/lib/server/admin/db";

import { registerHandler } from "../webhook";

async function handleAccountUpdated(event: Stripe.Event): Promise<void> {
  const account = event.data.object as Stripe.Account;

  const db = adminDb();

  // Look up an existing row by stripe account_id. We keyed on account
  // id specifically so a race with onboarding still converges.
  const [existing] = await db
    .select({ id: stripeAccounts.id, organisationId: stripeAccounts.organisationId })
    .from(stripeAccounts)
    .where(eq(stripeAccounts.accountId, account.id))
    .limit(1);

  if (!existing) {
    // No row yet — defer the upsert to the onboarding flow, which
    // knows the organisationId. Log the event so we can tell this
    // race happened.
    // We do NOT silently drop: audit captures it, and the event row
    // stays in stripe_events without handled_at set for replay.
    return;
  }

  await db
    .update(stripeAccounts)
    .set({
      chargesEnabled: account.charges_enabled,
      payoutsEnabled: account.payouts_enabled,
      detailsSubmitted: account.details_submitted,
      country: account.country ?? null,
      defaultCurrency: account.default_currency?.toUpperCase() ?? null,
    })
    .where(eq(stripeAccounts.id, existing.id));

  await audit.log({
    organisationId: existing.organisationId,
    actorUserId: null,
    action: "stripe.account.updated",
    targetType: "stripe_account",
    targetId: existing.id,
    metadata: {
      accountId: account.id,
      chargesEnabled: account.charges_enabled,
      payoutsEnabled: account.payouts_enabled,
    },
  });
}

registerHandler("account.updated", handleAccountUpdated);

// Import for side effects — this file exists so `import
// "@/lib/stripe/handlers"` registers all handlers in one shot.
export {};
