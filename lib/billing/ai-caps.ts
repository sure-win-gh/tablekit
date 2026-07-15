// Tier-based monthly AI budget — the hard cap on Bedrock spend.
//
// Code-defined like FEATURES (lib/auth/entitlements.ts) and
// CHANNEL_COST_PENCE (lib/billing/usage.ts): plans are code, caps are
// code. A per-org DB override is a small additive migration if a real
// customer ever needs a bespoke budget.
//
// Enforcement is pre-claim in the enquiry runner ("queue-paused"):
// over-budget enquiries stay 'received' with parse_attempts untouched,
// and processing resumes automatically when billingPeriod() rolls
// over. See docs/specs/ai-usage.md.

import "server-only";

import { and, eq, sql } from "drizzle-orm";

import { getPlan } from "@/lib/auth/require-plan";
import { estAiCostPence } from "@/lib/billing/ai-usage";
import { billingPeriod } from "@/lib/billing/usage";
import { aiUsage } from "@/lib/db/schema";
import { adminDb } from "@/lib/server/admin/db";

import type { Plan } from "@/lib/auth/plan-level";

// £5/month at Haiku rates is ~3,800 typical enquiries — ample
// headroom over any real venue's inbox while bounding the worst case
// (abuse loop, mail-storm) to pocket money. Free/Core are zero because
// the enquiry feature itself is Plus-gated.
export const AI_MONTHLY_BUDGET_PENCE: Record<Plan, number> = {
  free: 0,
  core: 0,
  plus: 500,
};

export type AiBudgetCheck = {
  ok: boolean;
  spentPence: number;
  budgetPence: number;
};

/**
 * Is the org still inside its monthly AI budget? Reads the ledger SUM
 * for the current period and derives cost — same math the dashboard
 * readout uses, so the operator's number and the enforcement number
 * can't disagree.
 */
export async function checkAiBudget(orgId: string, now: Date): Promise<AiBudgetCheck> {
  const plan = await getPlan(orgId);
  const budgetPence = AI_MONTHLY_BUDGET_PENCE[plan];
  if (budgetPence <= 0) {
    // Plan without an AI budget — nothing to spend. (Shouldn't occur
    // in practice: enquiries are Plus-gated at the webhook.)
    return { ok: false, spentPence: 0, budgetPence };
  }

  const period = billingPeriod(now);
  const [sums] = await adminDb()
    .select({
      inputTokens: sql<string>`coalesce(sum(${aiUsage.inputTokens}), 0)`,
      outputTokens: sql<string>`coalesce(sum(${aiUsage.outputTokens}), 0)`,
    })
    .from(aiUsage)
    .where(and(eq(aiUsage.organisationId, orgId), eq(aiUsage.period, period)));

  const spentPence = estAiCostPence({
    inputTokens: Number(sums?.inputTokens ?? 0),
    outputTokens: Number(sums?.outputTokens ?? 0),
  });
  return { ok: spentPence < budgetPence, spentPence, budgetPence };
}
