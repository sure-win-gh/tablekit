// API request logging — writes to api_request_log table.
//
// One row per authenticated request. Fields are minimum: method,
// path (no query string), status, latency. NEVER request or
// response bodies — operator-typed `notes` and guest PII are
// reachable through the API surface and we don't want them in
// this table. Per docs/specs/public-api.md acceptance #6.
//
// Fire-and-forget from the wrapper. If the INSERT fails (DB
// outage, etc.) we log to console and let the request continue
// — telemetry must not fail user requests.
//
// Retention: 90 days, swept by /api/cron/api-request-log-retention.

import "server-only";

import { lt } from "drizzle-orm";

import { apiRequestLog } from "@/lib/db/schema";
import { adminDb } from "@/lib/server/admin/db";

export type LogRequestArgs = {
  organisationId: string;
  apiKeyId: string;
  method: string;
  path: string;
  status: number;
  latencyMs: number;
};

export async function logRequest(args: LogRequestArgs): Promise<void> {
  try {
    await adminDb()
      .insert(apiRequestLog)
      .values({
        organisationId: args.organisationId,
        apiKeyId: args.apiKeyId,
        method: args.method,
        // Cap defensively at the CHECK bound. Real paths are <100
        // chars; a longer one means a bug or a hostile client and
        // we'd rather log a truncated row than reject the request.
        path: args.path.slice(0, 500),
        status: args.status,
        latencyMs: Math.min(Math.max(0, Math.floor(args.latencyMs)), 300000),
      });
  } catch (err) {
    // Telemetry failure must not affect the request. Log + drop.
    console.error("[api/v1] request-log insert failed", {
      apiKeyId: args.apiKeyId,
      error: err instanceof Error ? err.name : "Unknown",
    });
  }
}

// 90-day retention sweep. Single DELETE backed by
// api_request_log_created_at_idx. In steady-state the daily sweep
// deletes one day's worth of rows; on a fresh deploy with no
// historical data there's nothing to scan. Either way the index
// makes the WHERE cheap and the unbounded DELETE is fine — no
// need for the SELECT-then-DELETE batching the enquiries
// retention sweep uses (which exists there because of the
// per-row encrypted-cipher cleanup, irrelevant here).
export const RETENTION_DAYS = 90;
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;

export type SweepResult = { deleted: number; cutoff: string };

export async function sweepExpiredRequestLog(opts?: { now?: Date }): Promise<SweepResult> {
  const now = opts?.now ?? new Date();
  const cutoff = new Date(now.getTime() - RETENTION_MS);

  const deleted = await adminDb()
    .delete(apiRequestLog)
    .where(lt(apiRequestLog.createdAt, cutoff))
    .returning({ id: apiRequestLog.id });

  return { deleted: deleted.length, cutoff: cutoff.toISOString() };
}
