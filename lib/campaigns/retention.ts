// Campaign-send retention sweep.
//
// campaign_sends carry guest-linked behavioural data (open/click
// engagement). We don't keep it indefinitely: rows older than the
// retention window are hard-deleted, removing the guest linkage + the
// engagement timestamps. The parent campaign's aggregate counts (non-PII
// tallies on `campaigns.counts`) are retained for reporting. Guest
// erasure deletes a guest's rows sooner (lib/dsar/scrub.ts).

import "server-only";

import { lt } from "drizzle-orm";

import { campaignSends } from "@/lib/db/schema";
import { adminDb } from "@/lib/server/admin/db";

// 24 months — matches the engagement retention rule in gdpr.md.
export const CAMPAIGN_SEND_RETENTION_MONTHS = 24;

export type RetentionResult = { deleted: number };

// The cutoff instant: rows created before this are swept. Pure +
// `now`-injected so the boundary math is unit-testable.
export function retentionCutoff(now: Date): Date {
  const cutoff = new Date(now);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - CAMPAIGN_SEND_RETENTION_MONTHS);
  return cutoff;
}

export async function sweepCampaignSendRetention(now: Date = new Date()): Promise<RetentionResult> {
  const deleted = await adminDb()
    .delete(campaignSends)
    .where(lt(campaignSends.createdAt, retentionCutoff(now)))
    .returning({ id: campaignSends.id });

  return { deleted: deleted.length };
}
