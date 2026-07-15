// AI (Bedrock) usage ledger — writer + derived cost.
//
// Mirrors lib/billing/usage.ts (the message_usage pattern): a monthly
// (org, period, venue) upsert incremented per Bedrock call. Token
// counts are stored; cost is DERIVED here at read time — per-call
// cost is a fraction of a penny, so an incremented pence column would
// round to zero, and deriving lets price-map corrections apply
// retroactively. Token counts are non-PII aggregates.
//
// See docs/specs/ai-usage.md.

import "server-only";

import { sql } from "drizzle-orm";

import { billingPeriod } from "@/lib/billing/usage";
import { aiUsage } from "@/lib/db/schema";
import { adminDb } from "@/lib/server/admin/db";

// Claude Haiku 4.5 on Bedrock (anthropic.claude-haiku-4-5-*), the only
// model the enquiry parser uses: $1 / MTok input, $5 / MTok output.
// Fixed conversion constant rather than a live FX feed — this ledger
// estimates for budgeting, the AWS invoice is the truth. Update both
// together if the model in lib/llm/bedrock.ts changes.
const USD_PER_MTOK_INPUT = 1;
const USD_PER_MTOK_OUTPUT = 5;
const PENCE_PER_USD = 80;

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
};

/**
 * Estimated cost in pence (fractional — callers round for display).
 */
export function estAiCostPence(usage: TokenUsage): number {
  const usd =
    (usage.inputTokens / 1_000_000) * USD_PER_MTOK_INPUT +
    (usage.outputTokens / 1_000_000) * USD_PER_MTOK_OUTPUT;
  return usd * PENCE_PER_USD;
}

/**
 * Record one Bedrock call against the (org, period, venue) ledger row.
 * Same non-idempotent-per-call contract as recordUsage(): the runner
 * invokes it exactly once per parse attempt that reached Bedrock.
 */
export async function recordAiUsage(params: {
  organisationId: string;
  venueId: string;
  usage: TokenUsage;
  now: Date;
}): Promise<void> {
  const { organisationId, venueId, usage, now } = params;
  const period = billingPeriod(now);
  await adminDb()
    .insert(aiUsage)
    .values({
      organisationId,
      venueId,
      period,
      callCount: 1,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    })
    .onConflictDoUpdate({
      target: [aiUsage.organisationId, aiUsage.period, aiUsage.venueId],
      set: {
        callCount: sql`${aiUsage.callCount} + 1`,
        inputTokens: sql`${aiUsage.inputTokens} + ${usage.inputTokens}`,
        outputTokens: sql`${aiUsage.outputTokens} + ${usage.outputTokens}`,
        updatedAt: sql`now()`,
      },
    });
}
