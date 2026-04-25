// Enqueue a message row. INSERT with ON CONFLICT DO NOTHING on the
// (booking_id, template, channel) unique index — second enqueue for
// the same combination is a silent no-op, per the spec's idempotency
// requirement.
//
// Callers (booking-create, transition handlers, cron sweepers) wrap
// this; this module knows nothing about why.

import "server-only";

import { messages } from "@/lib/db/schema";
import { audit } from "@/lib/server/admin/audit";
import { adminDb } from "@/lib/server/admin/db";

import type { MessageChannel, MessageTemplate } from "./registry";

export type EnqueueResult = {
  messageId: string | null; // null = duplicate (already enqueued)
};

export async function enqueueMessage(input: {
  bookingId: string;
  organisationId: string;
  template: MessageTemplate;
  channel: MessageChannel;
  // Optional first-attempt delay. Reminders use this; immediate sends
  // (confirmation, cancelled) leave it absent so next_attempt_at
  // defaults to now() and the worker picks the row up on its next
  // tick.
  scheduleAt?: Date;
}): Promise<EnqueueResult> {
  const db = adminDb();
  const inserted = await db
    .insert(messages)
    .values({
      organisationId: input.organisationId, // overwritten by enforce trigger
      bookingId: input.bookingId,
      template: input.template,
      channel: input.channel,
      ...(input.scheduleAt ? { nextAttemptAt: input.scheduleAt } : {}),
    })
    .onConflictDoNothing({
      target: [messages.bookingId, messages.template, messages.channel],
    })
    .returning({ id: messages.id });

  const id = inserted[0]?.id ?? null;
  if (id) {
    await audit.log({
      organisationId: input.organisationId,
      actorUserId: null,
      action: "message.queued",
      targetType: "message",
      targetId: id,
      metadata: {
        bookingId: input.bookingId,
        template: input.template,
        channel: input.channel,
      },
    });
  }
  return { messageId: id };
}

// Marker timestamp used to release rows stuck in 'sending' for too
// long (the worker crashed mid-send). The worker re-claim path uses
// this — exported so callers don't recompute the threshold.
export const STUCK_SENDING_THRESHOLD_MS = 5 * 60 * 1000;

// Exponential backoff schedule. attempts is the count BEFORE this
// failure (so the first retry has attempts=1 and gets the 1-min delay).
// Returns null when we've exhausted retries — caller marks failed.
export function backoffMs(attempts: number): number | null {
  switch (attempts) {
    case 1:
      return 60_000; // 1 minute
    case 2:
      return 5 * 60_000; // 5 minutes
    case 3:
      return 15 * 60_000; // 15 minutes
    case 4:
      return 60 * 60_000; // 1 hour
    default:
      return null; // exhausted — spec says max 5 attempts
  }
}

// Truncate error messages stored on the row. Keeps the column lean +
// avoids accidentally surfacing very large stack traces in dashboard
// reads. 500 chars matches the comment in the schema.
export function truncateError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.length > 500 ? raw.slice(0, 499) + "…" : raw;
}
