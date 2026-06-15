// Idempotency claim for inbound POS webhooks, race-safe against a crash
// between claiming the event and ingesting it.
//
// The naive "INSERT ON CONFLICT DO NOTHING → if no row, it's a duplicate"
// loses an order if ingest throws AFTER the claim row commits: the provider
// retries, hits the conflict, and we skip it forever. So a conflict is only a
// true duplicate when the existing row's processed_at is set. A claimed-but-
// unprocessed row (prior crash) is RECOVERED — we re-ingest (the order upsert
// is idempotent, so no double count) and then stamp processed_at.

import "server-only";

import { and, eq } from "drizzle-orm";

import { posWebhookEvents } from "@/lib/db/schema";
import { adminDb } from "@/lib/server/admin/db";

import type { PosProvider } from "./connection";

export type ClaimOutcome =
  | { status: "new" | "recover"; eventRowId: string }
  | { status: "duplicate" };

export async function claimPosWebhookEvent(params: {
  organisationId: string;
  connectionId: string;
  provider: PosProvider;
  externalEventId: string;
}): Promise<ClaimOutcome> {
  const db = adminDb();

  const [inserted] = await db
    .insert(posWebhookEvents)
    .values({
      organisationId: params.organisationId, // rewritten by trigger from connection
      connectionId: params.connectionId,
      provider: params.provider,
      externalEventId: params.externalEventId,
    })
    .onConflictDoNothing({
      target: [posWebhookEvents.provider, posWebhookEvents.externalEventId],
    })
    .returning({ id: posWebhookEvents.id });

  if (inserted) return { status: "new", eventRowId: inserted.id };

  // Conflict — only a duplicate if the prior claim was actually processed.
  const [existing] = await db
    .select({ id: posWebhookEvents.id, processedAt: posWebhookEvents.processedAt })
    .from(posWebhookEvents)
    .where(
      and(
        eq(posWebhookEvents.provider, params.provider),
        eq(posWebhookEvents.externalEventId, params.externalEventId),
      ),
    )
    .limit(1);

  if (!existing) return { status: "duplicate" }; // raced + vanished; treat as no-op
  if (existing.processedAt) return { status: "duplicate" };
  return { status: "recover", eventRowId: existing.id };
}

export async function markPosWebhookProcessed(eventRowId: string): Promise<void> {
  await adminDb()
    .update(posWebhookEvents)
    .set({ processedAt: new Date() })
    .where(eq(posWebhookEvents.id, eventRowId));
}
