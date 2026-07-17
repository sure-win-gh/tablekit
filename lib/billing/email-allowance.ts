// Marketing-email allowance state for an org: how much of this month's
// included sends are used, derived from campaign_sends (the send rows ARE
// the sends — no second ledger to drift). Transactional email is never
// counted here. See docs/specs/email-broadcast-billing.md.

import "server-only";

import { and, eq, gte, isNotNull, lt, sql } from "drizzle-orm";

import { toPlan } from "@/lib/auth/plan-level";
import { MARKETING_EMAIL, monthBoundsUtc } from "@/lib/billing/marketing-email";
import { campaignSends } from "@/lib/db/schema";
import { adminDb } from "@/lib/server/admin/db";

export type EmailAllowanceState = { allowance: number; used: number; remaining: number };

// Rollout flag (spec step 1 is a display-only period): while off, email
// campaigns show allowance numbers but reserve nothing — today's free
// behaviour. Flip via env once the 30-day pricing notice has run.
export function isEmailOverageEnforced(): boolean {
  return process.env["EMAIL_OVERAGE_ENFORCED"] === "true";
}

// Marketing emails sent by the org in `now`'s UTC calendar month. Counts
// rows whose send succeeded (sent_at stamped), regardless of later
// delivered/bounced transitions — served by the partial index
// campaign_sends_org_email_sent_idx.
export async function getEmailAllowanceState(
  organisationId: string,
  plan: string,
  now: Date,
): Promise<EmailAllowanceState> {
  const allowance = MARKETING_EMAIL.allowancePerMonth[toPlan(plan)];
  const { start, end } = monthBoundsUtc(now);
  const [row] = await adminDb()
    .select({ n: sql<number>`count(*)::int` })
    .from(campaignSends)
    .where(
      and(
        eq(campaignSends.organisationId, organisationId),
        eq(campaignSends.channel, "email"),
        isNotNull(campaignSends.sentAt),
        gte(campaignSends.sentAt, start),
        lt(campaignSends.sentAt, end),
      ),
    );
  const used = row?.n ?? 0;
  return { allowance, used, remaining: Math.max(0, allowance - used) };
}
