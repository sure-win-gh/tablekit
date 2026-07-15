// Operator-facing AI usage summary — current month's Bedrock call
// volume, token totals, derived cost, and budget position. Mirrors
// lib/billing/usage-summary.ts; reads under the caller's db handle
// (withUser member-read RLS on operator surfaces).

import "server-only";

import { and, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { AI_MONTHLY_BUDGET_PENCE } from "@/lib/billing/ai-caps";
import { estAiCostPence } from "@/lib/billing/ai-usage";
import { aiUsage } from "@/lib/db/schema";
import type * as schema from "@/lib/db/schema";

import { billingPeriod } from "./usage";

import type { Plan } from "@/lib/auth/plan-level";

type Db = NodePgDatabase<typeof schema>;

export type AiUsageSummary = {
  period: string;
  callCount: number;
  inputTokens: number;
  outputTokens: number;
  estCostPence: number;
  budgetPence: number;
  overBudget: boolean;
  /** First day of the next period — when a paused queue resumes. */
  resumesAt: Date;
};

// Plan is a parameter (not re-read) so callers that already resolved
// it (every gated page does) don't pay a second org lookup, and the
// summary works under withUser without adminDb.
export async function getAiUsageSummary(
  db: Db,
  organisationId: string,
  plan: Plan,
  now: Date,
): Promise<AiUsageSummary> {
  const period = billingPeriod(now);
  const [sums] = await db
    .select({
      callCount: sql<string>`coalesce(sum(${aiUsage.callCount}), 0)`,
      inputTokens: sql<string>`coalesce(sum(${aiUsage.inputTokens}), 0)`,
      outputTokens: sql<string>`coalesce(sum(${aiUsage.outputTokens}), 0)`,
    })
    .from(aiUsage)
    .where(and(eq(aiUsage.organisationId, organisationId), eq(aiUsage.period, period)));

  const callCount = Number(sums?.callCount ?? 0);
  const inputTokens = Number(sums?.inputTokens ?? 0);
  const outputTokens = Number(sums?.outputTokens ?? 0);
  const estCostPence = estAiCostPence({ inputTokens, outputTokens });
  const budgetPence = AI_MONTHLY_BUDGET_PENCE[plan];
  const resumesAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

  return {
    period,
    callCount,
    inputTokens,
    outputTokens,
    estCostPence,
    budgetPence,
    overBudget: budgetPence > 0 && estCostPence >= budgetPence,
    resumesAt,
  };
}
