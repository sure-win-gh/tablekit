// Retention sweep for pos_orders.
//
// Order/spend data is held for CRM, not accounting, so it rolls off on a
// per-org window: organisations.pos_retention_months (nullable → default
// 24). Mirrors the campaign-send sweep cadence. Bounded + resumable: a
// fresh deploy with a large backlog drains over several nightly ticks.
//
// Deleting orders changes a guest's spend, so after each batch we recompute
// guest_spend_summary for the affected guests. Hard delete — the whole point
// is that the bytes leave the database.

import "server-only";

import { inArray, sql } from "drizzle-orm";

import { posOrders } from "@/lib/db/schema";
import { audit } from "@/lib/server/admin/audit";
import { adminDb } from "@/lib/server/admin/db";

import { recomputeGuestSpend } from "./rollup";

export const POS_DEFAULT_RETENTION_MONTHS = 24;
const DEFAULT_BATCH = 1000;

export type PosSweepResult = { deleted: number };

export async function sweepExpiredPosOrders(opts?: {
  now?: Date;
  batchSize?: number;
}): Promise<PosSweepResult> {
  const now = opts?.now ?? new Date();
  const batchSize = opts?.batchSize ?? DEFAULT_BATCH;
  const db = adminDb();

  // Per-org cutoff = now - coalesce(pos_retention_months, 24) months. Pick a
  // bounded batch of the oldest eligible orders first (Postgres can't LIMIT a
  // DELETE), oldest first for predictable forward progress.
  const picked = await db.execute<{
    id: string;
    organisation_id: string;
    guest_id: string | null;
  }>(sql`
    select po.id, po.organisation_id, po.guest_id
    from pos_orders po
    join organisations o on o.id = po.organisation_id
    where po.closed_at < ${now}::timestamptz
      - make_interval(months => coalesce(o.pos_retention_months, ${POS_DEFAULT_RETENTION_MONTHS}))
    order by po.closed_at asc
    limit ${batchSize}
  `);

  const rows = picked.rows;
  if (rows.length === 0) return { deleted: 0 };

  await db.delete(posOrders).where(
    inArray(
      posOrders.id,
      rows.map((r) => r.id),
    ),
  );

  // Recompute spend for every affected guest (their totals dropped).
  const affectedGuests = new Set<string>();
  for (const r of rows) if (r.guest_id) affectedGuests.add(r.guest_id);
  for (const guestId of affectedGuests) await recomputeGuestSpend(guestId);

  // Heartbeat: one audit entry per org with deletes (queryable ground truth).
  const byOrg = new Map<string, number>();
  for (const r of rows) byOrg.set(r.organisation_id, (byOrg.get(r.organisation_id) ?? 0) + 1);
  for (const [organisationId, count] of byOrg) {
    await audit.log({
      organisationId,
      action: "pos.retention.swept",
      targetType: "pos_order",
      metadata: { deleted: count },
    });
  }

  return { deleted: rows.length };
}
