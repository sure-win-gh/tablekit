// Shared ingest pipeline — every POS path (Square / Lightspeed / generic
// webhook / CSV / backfill) converges here after producing a NormalisedOrder:
//
//   strip card data (SAQ-A guard)
//     → match guest (email_hash | booking | none)
//     → upsert pos_orders on (connection_id, external_order_id)
//     → recompute guest_spend_summary for the affected guest(s)
//     → audit.log('pos.order.ingested', { non-PII })
//
// Idempotent at the row level via the (connection_id, external_order_id)
// unique index: a replay updates the same row rather than duplicating. All
// writes go through adminDb() — the table has no authenticated write policy.

import "server-only";

import { and, eq } from "drizzle-orm";

import { posOrders } from "@/lib/db/schema";
import { audit } from "@/lib/server/admin/audit";
import { adminDb } from "@/lib/server/admin/db";
import { encryptPii } from "@/lib/security/crypto";

import { stripCardData } from "./card-guard";
import { matchOrder, type MatchMethod } from "./match";
import { recomputeGuestSpend } from "./rollup";
import type { NormalisedOrder } from "./types";

export type IngestOrderParams = {
  connectionId: string;
  organisationId: string;
  venueId: string;
  // Art. 9 opt-in (pos_connections.line_items_enabled). When false, no
  // itemisation is stored at all, even if the payload carries it.
  lineItemsEnabled: boolean;
  groupCrmEnabled: boolean;
  order: NormalisedOrder;
};

export type IngestResult = {
  orderId: string;
  guestId: string | null;
  matchMethod: MatchMethod | null;
  scrubbedFields: string[];
};

export async function ingestOrder(params: IngestOrderParams): Promise<IngestResult> {
  const { connectionId, organisationId, venueId, lineItemsEnabled, groupCrmEnabled } = params;
  const db = adminDb();

  // 1 — SAQ-A card guard before anything is persisted or logged.
  const { order, scrubbed } = stripCardData(params.order);

  // 2 — deterministic guest match.
  const match = await matchOrder({ organisationId, venueId, order, groupCrmEnabled });

  // 3 — line items only when the connection opted in; encrypted at rest.
  const lineItemsCipher =
    lineItemsEnabled && order.lineItems && order.lineItems.length > 0
      ? await encryptPii(organisationId, JSON.stringify(order.lineItems))
      : null;

  // Capture any prior guest link so we can refresh that summary too if a
  // re-ingest re-attributes the order to a different guest.
  const [existing] = await db
    .select({ guestId: posOrders.guestId })
    .from(posOrders)
    .where(
      and(
        eq(posOrders.connectionId, connectionId),
        eq(posOrders.externalOrderId, order.externalOrderId),
      ),
    )
    .limit(1);
  const previousGuestId = existing?.guestId ?? null;

  // 4 — upsert the normalised order.
  const [row] = await db
    .insert(posOrders)
    .values({
      organisationId, // rewritten by enforce trigger from the venue
      venueId,
      connectionId,
      provider: order.provider,
      externalOrderId: order.externalOrderId,
      guestId: match.guestId,
      bookingId: match.bookingId,
      totalMinor: order.totalMinor,
      tipMinor: order.tipMinor,
      taxMinor: order.taxMinor,
      currency: order.currency,
      coverCount: order.coverCount,
      paymentMethodLabel: order.paymentMethodLabel,
      lineItemsCipher,
      closedAt: order.closedAt,
      matchMethod: match.matchMethod,
      rawProviderRef: order.rawProviderRef,
    })
    .onConflictDoUpdate({
      target: [posOrders.connectionId, posOrders.externalOrderId],
      set: {
        guestId: match.guestId,
        bookingId: match.bookingId,
        totalMinor: order.totalMinor,
        tipMinor: order.tipMinor,
        taxMinor: order.taxMinor,
        currency: order.currency,
        coverCount: order.coverCount,
        paymentMethodLabel: order.paymentMethodLabel,
        lineItemsCipher,
        closedAt: order.closedAt,
        matchMethod: match.matchMethod,
        rawProviderRef: order.rawProviderRef,
        updatedAt: new Date(),
      },
    })
    .returning({ id: posOrders.id });

  if (!row) throw new Error("lib/pos/ingest.ts: order upsert returned no row");

  // 5 — refresh the affected guest summaries (new + previous if it moved).
  const toRefresh = new Set<string>();
  if (match.guestId) toRefresh.add(match.guestId);
  if (previousGuestId && previousGuestId !== match.guestId) toRefresh.add(previousGuestId);
  for (const gid of toRefresh) await recomputeGuestSpend(gid);

  // 6 — audit with non-PII metadata only (ids, amounts, match method).
  await audit.log({
    organisationId,
    action: "pos.order.ingested",
    targetType: "pos_order",
    targetId: row.id,
    metadata: {
      provider: order.provider,
      venueId,
      connectionId,
      matchMethod: match.matchMethod,
      matched: Boolean(match.guestId),
      totalMinor: order.totalMinor,
      cardFieldsScrubbed: scrubbed.length,
    },
  });

  return {
    orderId: row.id,
    guestId: match.guestId,
    matchMethod: match.matchMethod,
    scrubbedFields: scrubbed,
  };
}
