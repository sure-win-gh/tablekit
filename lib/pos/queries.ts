// Dashboard reads for POS surfaces. All run under withUser (RLS), so they
// are automatically org/venue-scoped — a caller only ever sees their own
// connections, orders, and spend summaries.

import "server-only";

import { and, desc, eq, isNull } from "drizzle-orm";

import { withUser } from "@/lib/db/client";
import { guestSpendSummary, posConnections, posOrders } from "@/lib/db/schema";

export type VenuePosConnection = {
  id: string;
  provider: string;
  status: string;
  externalAccountId: string | null;
  lineItemsEnabled: boolean;
  lastSyncedAt: Date | null;
  lastError: string | null;
};

export async function loadVenuePosConnections(venueId: string): Promise<VenuePosConnection[]> {
  return withUser((db) =>
    db
      .select({
        id: posConnections.id,
        provider: posConnections.provider,
        status: posConnections.status,
        externalAccountId: posConnections.externalAccountId,
        lineItemsEnabled: posConnections.lineItemsEnabled,
        lastSyncedAt: posConnections.lastSyncedAt,
        lastError: posConnections.lastError,
      })
      .from(posConnections)
      .where(eq(posConnections.venueId, venueId)),
  );
}

export type UnmatchedOrder = {
  id: string;
  provider: string;
  totalMinor: number;
  currency: string;
  paymentMethodLabel: string | null;
  closedAt: Date;
};

export async function loadUnmatchedOrders(venueId: string, limit = 50): Promise<UnmatchedOrder[]> {
  return withUser((db) =>
    db
      .select({
        id: posOrders.id,
        provider: posOrders.provider,
        totalMinor: posOrders.totalMinor,
        currency: posOrders.currency,
        paymentMethodLabel: posOrders.paymentMethodLabel,
        closedAt: posOrders.closedAt,
      })
      .from(posOrders)
      .where(and(eq(posOrders.venueId, venueId), isNull(posOrders.guestId)))
      .orderBy(desc(posOrders.closedAt))
      .limit(limit),
  );
}

export type GuestSpend = {
  orderCount: number;
  totalSpendMinor: number;
  avgSpendMinor: number;
  lastOrderAt: Date | null;
  firstOrderAt: Date | null;
};

export async function loadGuestSpend(guestId: string): Promise<GuestSpend | null> {
  return withUser(async (db) => {
    const [row] = await db
      .select({
        orderCount: guestSpendSummary.orderCount,
        totalSpendMinor: guestSpendSummary.totalSpendMinor,
        avgSpendMinor: guestSpendSummary.avgSpendMinor,
        lastOrderAt: guestSpendSummary.lastOrderAt,
        firstOrderAt: guestSpendSummary.firstOrderAt,
      })
      .from(guestSpendSummary)
      .where(eq(guestSpendSummary.guestId, guestId))
      .limit(1);
    if (!row) return null;
    return { ...row, totalSpendMinor: Number(row.totalSpendMinor) };
  });
}
