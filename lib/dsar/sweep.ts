// sweepCompletedErasureScrubs — batch driver for the scrub job.
//
// Pulls erase DSARs that the operator has marked completed but the
// scrub hasn't run for yet, and processes them. Per-row try/catch so
// a single bad row doesn't block the queue.
//
// Called from:
//   * /api/cron/dsar-scrub on a daily Vercel cron schedule
//   * /dashboard/privacy-requests page (best-effort inline)

import "server-only";

import { and, eq, isNull } from "drizzle-orm";

import { dsarRequests } from "@/lib/db/schema";
import { adminDb } from "@/lib/server/admin/db";

import { runErasureScrub } from "./scrub";

export type SweepResult = {
  considered: number;
  scrubbed: number;
  failed: number;
};

export async function sweepCompletedErasureScrubs(opts?: { limit?: number }): Promise<SweepResult> {
  const limit = opts?.limit ?? 50;
  const db = adminDb();

  const queue = await db
    .select({ id: dsarRequests.id })
    .from(dsarRequests)
    .where(
      and(
        eq(dsarRequests.kind, "erase"),
        eq(dsarRequests.status, "completed"),
        isNull(dsarRequests.scrubbedAt),
      ),
    )
    .limit(limit);

  let scrubbed = 0;
  let failed = 0;
  for (const row of queue) {
    try {
      const r = await runErasureScrub({ dsarId: row.id });
      if (r.ok) scrubbed += 1;
      else failed += 1;
    } catch (err) {
      failed += 1;
      console.error("[dsar/sweep] scrub failed:", {
        dsarId: row.id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { considered: queue.length, scrubbed, failed };
}
