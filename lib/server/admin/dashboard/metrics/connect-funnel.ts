// Stripe Connect onboarding funnel.
//
// Counts how many organisations have reached each stage of Connect
// onboarding. Backed by stripe_accounts flags (already kept in sync
// by the account.updated webhook handler). Total orgs is the
// denominator for the conversion-to-payouts ratio.
//
// Stages are nested: payouts_enabled => charges_enabled =>
// details_submitted => account exists. We report the raw count at
// each stage so the page can render the funnel either way.

import "server-only";

import { count, sql } from "drizzle-orm";

import { organisations, stripeAccounts } from "@/lib/db/schema";

import type { AdminDb } from "../types";

export type ConnectFunnel = {
  totalOrgs: number;
  hasAccount: number;
  detailsSubmitted: number;
  chargesEnabled: number;
  payoutsEnabled: number;
};

export async function getConnectFunnel(db: AdminDb): Promise<ConnectFunnel> {
  const [orgs, summary] = await Promise.all([
    db.select({ n: count() }).from(organisations),
    db
      .select({
        total: count(),
        detailsSubmitted: sql<number>`count(*) filter (where ${stripeAccounts.detailsSubmitted})::int`,
        chargesEnabled: sql<number>`count(*) filter (where ${stripeAccounts.chargesEnabled})::int`,
        payoutsEnabled: sql<number>`count(*) filter (where ${stripeAccounts.payoutsEnabled})::int`,
      })
      .from(stripeAccounts),
  ]);

  return {
    totalOrgs: orgs[0]?.n ?? 0,
    hasAccount: summary[0]?.total ?? 0,
    detailsSubmitted: summary[0]?.detailsSubmitted ?? 0,
    chargesEnabled: summary[0]?.chargesEnabled ?? 0,
    payoutsEnabled: summary[0]?.payoutsEnabled ?? 0,
  };
}
