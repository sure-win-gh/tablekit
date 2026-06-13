// Historical backfill runner for POS connections.
//
// The LIVE path is webhooks (ingest.ts) — it does not depend on this. Backfill
// is the one-time catch-up that pulls a venue's order history after they first
// connect, page by page, resumably (import-runner pattern): bounded per tick,
// last_synced_at as the watermark so a later tick continues where this stopped.
//
// Per-provider historical page-fetch is the extension point below
// (fetchBackfillPage): Square/Lightspeed list endpoints are wired here as each
// provider's read API is certified. Until a provider has a lister, its
// connections are skipped (last_synced_at stays null so they're retried),
// rather than being falsely marked synced. The bounded loop + watermark +
// ingest wiring are the stable contract.

import "server-only";

import { and, eq, isNull, sql } from "drizzle-orm";

import { posConnections } from "@/lib/db/schema";
import { audit } from "@/lib/server/admin/audit";
import { adminDb } from "@/lib/server/admin/db";

import { ingestOrder } from "./ingest";
import { loadIngestContextByConnectionId } from "./ingest-context";
import type { NormalisedOrder } from "./types";

const DEFAULT_MAX_CONNECTIONS = 5;

export type BackfillResult = { connectionsProcessed: number; ordersIngested: number };

// Provider dispatch for the historical page-fetch. Returns a (bounded) page of
// normalised orders, or null if no lister exists for the provider yet (→ skip,
// don't stamp). Implemented per-provider as the read API is certified.
async function fetchBackfillPage(_connectionId: string): Promise<NormalisedOrder[] | null> {
  // No provider lister certified yet — webhooks carry live orders. Returning
  // null leaves last_synced_at null so the connection is retried once a lister
  // lands. See docs/specs/pos-integrations-plan.md commit 9.
  return null;
}

export async function runPosBackfill(opts?: { maxConnections?: number }): Promise<BackfillResult> {
  const maxConnections = opts?.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
  const db = adminDb();

  // Connections that have never been backfilled, oldest first.
  const pending = await db
    .select({ id: posConnections.id })
    .from(posConnections)
    .where(and(eq(posConnections.status, "active"), isNull(posConnections.lastSyncedAt)))
    .orderBy(posConnections.createdAt)
    .limit(maxConnections);

  let connectionsProcessed = 0;
  let ordersIngested = 0;

  for (const { id: connectionId } of pending) {
    const page = await fetchBackfillPage(connectionId);
    if (page === null) continue; // no lister for this provider yet

    const ctx = await loadIngestContextByConnectionId(connectionId);
    if (!ctx) continue;

    for (const order of page) {
      await ingestOrder({
        connectionId: ctx.connectionId,
        organisationId: ctx.organisationId,
        venueId: ctx.venueId,
        lineItemsEnabled: ctx.lineItemsEnabled,
        groupCrmEnabled: ctx.groupCrmEnabled,
        order,
      });
      ordersIngested++;
    }

    // Stamp the watermark so the next tick continues past this connection.
    await db
      .update(posConnections)
      .set({ lastSyncedAt: sql`now()`, updatedAt: sql`now()` })
      .where(eq(posConnections.id, connectionId));
    connectionsProcessed++;

    await audit.log({
      organisationId: ctx.organisationId,
      action: "pos.backfill.swept",
      targetType: "pos_connection",
      targetId: connectionId,
      metadata: { ordersIngested: page.length },
    });
  }

  return { connectionsProcessed, ordersIngested };
}
