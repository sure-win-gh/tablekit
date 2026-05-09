// Webhook dispatcher.
//
// Called from the booking domain after a side-effect lands.
// `dispatchEvent` looks up active subscriptions for the org that
// listed this event_type, then INSERTs a `pending` delivery row per
// subscription. The cron picks them up next tick (~1 minute) and
// POSTs the signed body via `attemptDelivery` (lib/webhooks/deliver.ts).
//
// Deliberately fire-and-forget from the caller's perspective. A
// failure to dispatch (e.g. transient DB error) MUST NOT fail the
// originating booking — the action that triggered the event is the
// source of truth, and a missed webhook is recoverable later via
// PR6c's manual replay button.

import "server-only";

import { and, eq, isNull } from "drizzle-orm";

import { webhookDeliveries, webhookSubscriptions } from "@/lib/db/schema";
import { adminDb } from "@/lib/server/admin/db";

import type { WebhookEvent } from "./events";

export type DispatchInput = {
  organisationId: string;
  eventType: WebhookEvent;
  // Stable per-event-instance id so a subscriber can dedupe at
  // their end. The dispatcher does NOT enforce uniqueness; the
  // caller picks something deterministic (e.g. `${eventType}:${bookingId}`).
  eventId: string;
  // Plaintext jsonb body. Booking events ship ids + timestamps —
  // no PII at the column level. Operator-typed `notes` MAY end up
  // in the payload; same caveat as the bookings list endpoint
  // (gdpr.md note added in PR2).
  payload: Record<string, unknown>;
};

export async function dispatchEvent(input: DispatchInput): Promise<{ enqueued: number }> {
  const db = adminDb();

  // Find active, non-revoked subscriptions in this org that listed
  // this event type. The `events` column is text[]; we expand at
  // SQL time via ANY().
  const subs = await db
    .select({ id: webhookSubscriptions.id, events: webhookSubscriptions.events })
    .from(webhookSubscriptions)
    .where(
      and(
        eq(webhookSubscriptions.organisationId, input.organisationId),
        eq(webhookSubscriptions.active, true),
        isNull(webhookSubscriptions.revokedAt),
      ),
    );

  const matching = subs.filter((s) => s.events.includes(input.eventType));
  if (matching.length === 0) return { enqueued: 0 };

  await db.insert(webhookDeliveries).values(
    matching.map((s) => ({
      subscriptionId: s.id,
      organisationId: input.organisationId,
      eventType: input.eventType,
      eventId: input.eventId,
      payload: input.payload,
    })),
  );

  return { enqueued: matching.length };
}
