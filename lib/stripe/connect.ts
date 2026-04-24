// Stripe Connect onboarding helpers.
//
// Flow:
//   1. Operator clicks "Connect Stripe" in the dashboard.
//   2. startOnboarding creates (or reuses) an `acct_*` and an
//      `account_link` URL, persists the stripe_accounts row, returns
//      the URL for a redirect.
//   3. Operator completes Stripe's hosted KYC flow.
//   4. Stripe redirects back to /dashboard/stripe/return.
//   5. refreshAccountState pulls the latest flags from Stripe and
//      mirrors them onto stripe_accounts — belt-and-braces alongside
//      the account.updated webhook.

import "server-only";

import { eq } from "drizzle-orm";
import Stripe from "stripe";

import { stripeAccounts } from "@/lib/db/schema";
import { audit } from "@/lib/server/admin/audit";
import { adminDb } from "@/lib/server/admin/db";

import { paymentsDisabled, stripe } from "./client";

export type StripeAccountRow = {
  id: string;
  organisationId: string;
  accountId: string;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  country: string | null;
  defaultCurrency: string | null;
};

export async function getAccount(organisationId: string): Promise<StripeAccountRow | null> {
  const [row] = await adminDb()
    .select()
    .from(stripeAccounts)
    .where(eq(stripeAccounts.organisationId, organisationId))
    .limit(1);
  return row ?? null;
}

export type OnboardingResult =
  | { ok: true; url: string }
  | { ok: false; reason: "payments-disabled" }
  | { ok: false; reason: "stripe-error"; message: string };

// Returns the hosted onboarding URL. If the org already has a Stripe
// account, we reuse it and just mint a fresh account link.
export async function startOnboarding(
  organisationId: string,
  actorUserId: string,
  appUrl: string,
): Promise<OnboardingResult> {
  if (paymentsDisabled()) return { ok: false, reason: "payments-disabled" };

  const existing = await getAccount(organisationId);

  const db = adminDb();
  let accountId = existing?.accountId ?? null;

  try {
    if (!accountId) {
      const created = await stripe().accounts.create({
        type: "standard",
        metadata: { organisation_id: organisationId },
      });
      accountId = created.id;
      await db.insert(stripeAccounts).values({
        organisationId,
        accountId,
      });
    }

    const link = await stripe().accountLinks.create({
      account: accountId,
      // If the user aborts mid-flow, Stripe sends them to `refresh_url`
      // and we re-mint a fresh link. `return_url` fires on completion.
      refresh_url: `${appUrl}/dashboard/stripe/return?status=refresh`,
      return_url: `${appUrl}/dashboard/stripe/return?status=complete`,
      type: "account_onboarding",
    });

    await audit.log({
      organisationId,
      actorUserId,
      action: "stripe.connect.started",
      targetType: "stripe_account",
      targetId: accountId,
      metadata: { reused: Boolean(existing) },
    });

    return { ok: true, url: link.url };
  } catch (err) {
    // Stripe-side errors (Connect not activated on the platform,
    // geographic restrictions, missing capabilities) — surface the
    // raw Stripe message so the operator can act on it instead of a
    // generic "try again". Stripe error copy is aimed at developers
    // and is safe to show to authenticated operators.
    console.error("[lib/stripe/connect.ts] startOnboarding failed:", err);
    const message =
      err instanceof Stripe.errors.StripeError
        ? err.message
        : err instanceof Error
          ? err.message
          : "Unexpected Stripe error";
    return { ok: false, reason: "stripe-error", message };
  }
}

// Pull the latest flags from Stripe + mirror onto our row. Called
// from the return-URL handler; also a convenient "force refresh"
// button in the billing UI.
export async function refreshAccountState(organisationId: string): Promise<StripeAccountRow | null> {
  const row = await getAccount(organisationId);
  if (!row) return null;

  const acct = await stripe().accounts.retrieve(row.accountId);

  await adminDb()
    .update(stripeAccounts)
    .set({
      chargesEnabled: acct.charges_enabled ?? false,
      payoutsEnabled: acct.payouts_enabled ?? false,
      detailsSubmitted: acct.details_submitted ?? false,
      country: acct.country ?? null,
      defaultCurrency: acct.default_currency?.toUpperCase() ?? null,
    })
    .where(eq(stripeAccounts.organisationId, organisationId));

  return getAccount(organisationId);
}
