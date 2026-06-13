// Spend rollup — recompute guest_spend_summary from pos_orders.
//
// guest_spend_summary is a denormalised cache (read-hot for the profile
// spend panel + "top guests by spend" sort). It is ALWAYS rebuildable from
// pos_orders and is never the source of truth — recompute on every order
// upsert for the affected guest, and rebuild wholesale in the rebuild test.

import "server-only";

import { and, eq, sql } from "drizzle-orm";

import { guestSpendSummary, posOrders } from "@/lib/db/schema";
import { adminDb } from "@/lib/server/admin/db";

// Recompute (or delete) one guest's spend summary from their pos_orders.
// A guest with zero orders has no summary row (kept tidy; DSAR also deletes).
export async function recomputeGuestSpend(guestId: string): Promise<void> {
  const db = adminDb();

  const [agg] = await db
    .select({
      orderCount: sql<number>`count(*)::int`,
      totalSpend: sql<number>`coalesce(sum(${posOrders.totalMinor}), 0)::bigint`,
      firstOrderAt: sql<Date | null>`min(${posOrders.closedAt})`,
      lastOrderAt: sql<Date | null>`max(${posOrders.closedAt})`,
    })
    .from(posOrders)
    .where(eq(posOrders.guestId, guestId));

  const orderCount = Number(agg?.orderCount ?? 0);

  if (orderCount === 0) {
    await db.delete(guestSpendSummary).where(eq(guestSpendSummary.guestId, guestId));
    return;
  }

  const totalSpendMinor = Number(agg!.totalSpend);
  const avgSpendMinor = Math.round(totalSpendMinor / orderCount);
  // min()/max() over timestamptz come back as ISO strings via raw SQL —
  // coerce to Date so the timestamp column's driver mapper accepts them.
  const toDate = (v: Date | string | null): Date | null =>
    v == null ? null : v instanceof Date ? v : new Date(v);
  const firstOrderAt = toDate(agg!.firstOrderAt);
  const lastOrderAt = toDate(agg!.lastOrderAt);

  await db
    .insert(guestSpendSummary)
    .values({
      guestId,
      // Placeholder — rewritten by the enforce_guest_spend_summary_org_id
      // trigger from the guest on insert.
      organisationId: "00000000-0000-0000-0000-000000000000",
      orderCount,
      totalSpendMinor,
      avgSpendMinor,
      firstOrderAt,
      lastOrderAt,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: guestSpendSummary.guestId,
      set: {
        orderCount,
        totalSpendMinor,
        avgSpendMinor,
        firstOrderAt,
        lastOrderAt,
        updatedAt: new Date(),
      },
    });
}

// Wholesale rebuild for an org — proves the cache is reconstructable from
// pos_orders alone. Deletes the org's summaries, then recomputes one row
// per guest that has at least one order.
export async function rebuildGuestSpendForOrg(organisationId: string): Promise<number> {
  const db = adminDb();

  await db.delete(guestSpendSummary).where(eq(guestSpendSummary.organisationId, organisationId));

  const guestRows = await db
    .selectDistinct({ guestId: posOrders.guestId })
    .from(posOrders)
    .where(
      and(eq(posOrders.organisationId, organisationId), sql`${posOrders.guestId} is not null`),
    );

  let rebuilt = 0;
  for (const { guestId } of guestRows) {
    if (!guestId) continue;
    await recomputeGuestSpend(guestId);
    rebuilt++;
  }
  return rebuilt;
}
