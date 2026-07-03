// Resolve which legal entity (Stripe account) an organisation bills
// through. Single source for the org → entity lookup so every billing
// and Connect code path picks the same account.
//
// Reads organisations.billing_entity (set at signup by regionForCountry,
// effectively immutable — docs/specs/multi-region.md D7). Runs under
// adminDb() (RLS bypass) because webhook/cron callers have no session;
// interactive callers MUST pass an orgId already authorised for the
// current session (same contract as lib/billing/portal.ts).

import "server-only";

import { eq } from "drizzle-orm";

import { organisations } from "@/lib/db/schema";
import { assertBillingEntity, type BillingEntity } from "@/lib/regions/mapping";
import { adminDb } from "@/lib/server/admin/db";

export async function entityForOrg(orgId: string): Promise<BillingEntity> {
  const [org] = await adminDb()
    .select({ billingEntity: organisations.billingEntity })
    .from(organisations)
    .where(eq(organisations.id, orgId))
    .limit(1);
  if (!org) throw new Error(`lib/billing/entity.ts: org ${orgId} not found`);
  // The column is CHECK-constrained to 'uk'|'us'; an unknown value THROWS
  // (fail closed) rather than silently billing through the UK account.
  return assertBillingEntity(org.billingEntity);
}
