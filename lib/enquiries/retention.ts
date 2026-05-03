// 90-day retention sweeper for the enquiries table.
//
// Per docs/playbooks/gdpr.md retention table + docs/specs/ai-enquiry.md
// acceptance criterion 6: "Enquiry emails and drafts retained for 90
// days then purged". The clock is `received_at`, not `replied_at` —
// even a successfully-replied enquiry expires 90 days after it
// arrived, because the original guest body is the PII surface and
// the spec is about that surface, not the conversation lifecycle.
//
// Hard delete (no soft-delete column). The encrypted columns become
// recoverable forever otherwise — the whole point of this sweep is
// that PII bytes leave the database. The DEK survives in
// `organisations.wrapped_dek` so this is sufficient: even a backup
// restore plus a leaked snapshot of this table can't recover what
// was deleted, because the row itself is gone.
//
// Status agnostic: received-but-never-parsed rows expire on the same
// clock. The 3-attempt parse budget caps any one row at ~3 days of
// retry, so a 90-day-old `received` row is genuinely abandoned.

import "server-only";

import { inArray, lt } from "drizzle-orm";

import { enquiries } from "@/lib/db/schema";
import { adminDb } from "@/lib/server/admin/db";

// 90 days in milliseconds. Single source of truth for the retention
// horizon — keep in step with the gdpr.md retention table if the
// rule ever changes.
export const ENQUIRY_RETENTION_DAYS = 90;
const ENQUIRY_RETENTION_MS = ENQUIRY_RETENTION_DAYS * 24 * 60 * 60 * 1000;

// Default per-tick batch cap. Sized to comfortably finish inside a
// Vercel function timeout even on a backlog: 1000 deletes is well
// within budget for a single SQL DELETE … WHERE … RETURNING.
const DEFAULT_BATCH = 1000;

export type SweepResult = {
  // Rows deleted in this tick. Equal to the number of rows older
  // than the cutoff — we don't filter further, so a non-zero
  // `scanned` always equals `deleted`.
  deleted: number;
  // ISO of the cutoff actually used, for cron telemetry. Helpful
  // when chasing "why didn't this row delete?" — compare its
  // received_at to the cutoff that ran.
  cutoff: string;
};

export async function sweepExpiredEnquiries(opts?: {
  now?: Date;
  batchSize?: number;
}): Promise<SweepResult> {
  const now = opts?.now ?? new Date();
  const batchSize = opts?.batchSize ?? DEFAULT_BATCH;
  const cutoff = new Date(now.getTime() - ENQUIRY_RETENTION_MS);

  const db = adminDb();
  // Pick a bounded batch first, then DELETE … WHERE id IN (…). Postgres
  // doesn't allow LIMIT on DELETE directly. The two-step shape keeps
  // a runaway delete on a fresh deploy (year's worth of rows eligible)
  // bounded to `batchSize` per tick; subsequent ticks drain the rest.
  // We ORDER BY received_at ASC so the oldest rows go first — useful
  // if the sweep is throttled by a backlog and we want predictable
  // forward progress.
  const targets = await db
    .select({ id: enquiries.id })
    .from(enquiries)
    .where(lt(enquiries.receivedAt, cutoff))
    .orderBy(enquiries.receivedAt)
    .limit(batchSize);

  if (targets.length === 0) {
    return { deleted: 0, cutoff: cutoff.toISOString() };
  }

  const deleted = await db
    .delete(enquiries)
    .where(
      inArray(
        enquiries.id,
        targets.map((t) => t.id),
      ),
    )
    .returning({ id: enquiries.id });

  return {
    deleted: deleted.length,
    cutoff: cutoff.toISOString(),
  };
}
