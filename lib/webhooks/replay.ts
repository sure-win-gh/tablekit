// Manual replay of a webhook delivery (PR6c).
//
// "Replay" creates a fresh `pending` row with the same subscription,
// event_type, event_id, and payload as the original. The original
// row stays in its terminal state (succeeded/failed) for audit
// trail; the cron picks the new row up next tick.
//
// We do NOT mutate the original row — that would erase the
// historical record of what happened the first time around.
// Operators see two rows in the log: the original failure + the
// replay attempt with its own outcome.

import "server-only";

import { and, eq } from "drizzle-orm";

import { webhookDeliveries, webhookSubscriptions } from "@/lib/db/schema";
import { adminDb } from "@/lib/server/admin/db";

export type ReplayResult =
  | { ok: true; replayDeliveryId: string }
  | { ok: false; reason: "not-found" | "subscription-revoked" };

export async function replayDelivery(args: {
  deliveryId: string;
  organisationId: string;
}): Promise<ReplayResult> {
  const db = adminDb();

  const [original] = await db
    .select({
      subscriptionId: webhookDeliveries.subscriptionId,
      eventType: webhookDeliveries.eventType,
      eventId: webhookDeliveries.eventId,
      payload: webhookDeliveries.payload,
    })
    .from(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.id, args.deliveryId),
        eq(webhookDeliveries.organisationId, args.organisationId),
      ),
    )
    .limit(1);
  if (!original) return { ok: false, reason: "not-found" };

  // Don't replay against a revoked subscription — operators should
  // re-register first. Active=false (paused) is also rejected;
  // un-pause from the dashboard before replaying.
  const [sub] = await db
    .select({ active: webhookSubscriptions.active, revokedAt: webhookSubscriptions.revokedAt })
    .from(webhookSubscriptions)
    .where(eq(webhookSubscriptions.id, original.subscriptionId))
    .limit(1);
  if (!sub || sub.revokedAt || !sub.active) {
    return { ok: false, reason: "subscription-revoked" };
  }

  const [inserted] = await db
    .insert(webhookDeliveries)
    .values({
      subscriptionId: original.subscriptionId,
      organisationId: args.organisationId,
      eventType: original.eventType,
      eventId: original.eventId,
      payload: original.payload as Record<string, unknown>,
    })
    .returning({ id: webhookDeliveries.id });
  if (!inserted) throw new Error("lib/webhooks/replay.ts: insert returned no row");

  return { ok: true, replayDeliveryId: inserted.id };
}
