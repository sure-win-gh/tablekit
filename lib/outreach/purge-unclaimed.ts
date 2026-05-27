// Daily purge of unclaimed outreach orgs older than the TTL.
//
// Rationale: outreach claim links live 30 days
// (CLAIM_DEFAULT_TTL_MS in claim-token.ts). Past that point the link
// 404s anyway, and we don't want stale pre-populated venues
// accumulating PII (prospect email on outreach_claims), Stripe-style
// fake bookings, or the Place ID associations.
//
// Hard delete (no soft column). The cascade ON DELETE rule on every
// child table — venues, areas, tables, services, guests, bookings,
// booking_tables, outreach_claims — means a single `DELETE FROM
// organisations` wipes the entire blast radius. The partial index
// `organisations_unclaimed_idx` (migration 0039) keeps the daily
// scan O(unclaimed).
//
// Scope: only orgs created via /admin/outreach. The filter is
// `outreach_source IS NOT NULL` (set in create-claimable) plus
// `claimed_at IS NULL`. Existing pre-outreach orgs were backfilled
// to `claimed_at = created_at` in migration 0039 so they're safe.
//
// Audit posture: cron logs (Vercel) capture each invocation +
// returned count. We do not write per-org rows into
// platform_audit_log — doing so would re-introduce PII (prospect
// email) we just deleted. If a forensic record is needed later, the
// purge IDs can be reconstructed by joining cron log timestamps
// against the database backup retention window.

import "server-only";

import { and, inArray, isNotNull, isNull, lt } from "drizzle-orm";

import { organisations } from "@/lib/db/schema";
import { adminDb } from "@/lib/server/admin/db";

// 30 days — matches CLAIM_DEFAULT_TTL_MS in lib/outreach/claim-token.ts.
// The constant lives there as the source of truth for "how long does
// the link live"; this purge enforces the same horizon for orphan rows.
export const PURGE_HORIZON_DAYS = 30;
const PURGE_HORIZON_MS = PURGE_HORIZON_DAYS * 24 * 60 * 60 * 1000;

// Cap per tick so a backlog from an outage doesn't blow the Vercel
// function timeout. 200 deletes (× full cascade) is well within
// budget; a backlog larger than that drains over multiple nights.
const DEFAULT_BATCH = 200;

export type PurgeResult = {
  // Rows deleted in this tick.
  deleted: number;
  // ISO of the cutoff applied. Helpful for cron telemetry.
  cutoff: string;
};

export async function purgeUnclaimedOutreach(opts?: {
  now?: Date;
  limit?: number;
}): Promise<PurgeResult> {
  const now = opts?.now ?? new Date();
  const limit = opts?.limit ?? DEFAULT_BATCH;
  const cutoff = new Date(now.getTime() - PURGE_HORIZON_MS);

  const db = adminDb();

  // Two-step pattern (select-then-delete) gives us a row count without
  // depending on RETURNING semantics across the FK cascade, and lets
  // us cap the batch via LIMIT — DELETE doesn't accept LIMIT directly
  // on Postgres without a subquery.
  const candidates = await db
    .select({ id: organisations.id })
    .from(organisations)
    .where(
      and(
        isNull(organisations.claimedAt),
        isNotNull(organisations.outreachSource),
        lt(organisations.createdAt, cutoff),
      ),
    )
    .limit(limit);

  if (candidates.length === 0) {
    return { deleted: 0, cutoff: cutoff.toISOString() };
  }

  const ids = candidates.map((r) => r.id);

  // Re-apply the same predicates on the DELETE. If a prospect claims
  // an org in the millisecond between the SELECT and the DELETE,
  // claimed_at will have flipped non-null and the row drops out of
  // the delete set. Belt to the SELECT's braces.
  const result = await db
    .delete(organisations)
    .where(
      and(
        inArray(organisations.id, ids),
        isNull(organisations.claimedAt),
        isNotNull(organisations.outreachSource),
        lt(organisations.createdAt, cutoff),
      ),
    )
    .returning({ id: organisations.id });

  return { deleted: result.length, cutoff: cutoff.toISOString() };
}
