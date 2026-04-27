// Inline triggers — called from booking-create / transition handlers /
// payment webhooks immediately after a state change. Enqueues the
// matching message rows and optionally drives the worker inline so
// confirmations land in seconds rather than waiting for the next cron.
//
// Each trigger is fire-and-forget at the call site: errors here must
// not block the booking flow that drove them. Callers wrap in their
// own try/catch + console.error if they want.
//
// Channels per template are decided by templateChannels() in the
// registry, so adding SMS to confirmation later is a one-line change
// in the registry.

import "server-only";

import { enqueueMessage } from "./enqueue";
import { processNextBatch } from "./dispatch";
import { templateChannels, type MessageTemplate } from "./registry";

export type TriggerInput = {
  organisationId: string;
  bookingId: string;
};

// Drive the worker for a small number of rows immediately after
// enqueueing. Keeps confirmation emails sub-second on the happy path.
const INLINE_DRIVE_LIMIT = 5;

async function enqueueAllChannels(
  organisationId: string,
  bookingId: string,
  template: MessageTemplate,
  scheduleAt?: Date,
): Promise<void> {
  for (const channel of templateChannels(template)) {
    await enqueueMessage({
      organisationId,
      bookingId,
      template,
      channel,
      ...(scheduleAt ? { scheduleAt } : {}),
    });
  }
}

export async function onBookingConfirmed(input: TriggerInput): Promise<void> {
  await enqueueAllChannels(input.organisationId, input.bookingId, "booking.confirmation");
  // Schedule the 24h + 2h reminders here — much cheaper than the
  // cron sweeper having to find which bookings still need them.
  // Worker WHERE clause filters on next_attempt_at <= now() so these
  // sit dormant until their time comes round.
  // NOTE: requires the booking's start_at — we look it up via a
  // tiny query rather than threading it through every caller.
  await scheduleRemindersFor(input);
  await driveWorker();
}

export async function onBookingCancelled(input: TriggerInput): Promise<void> {
  await enqueueAllChannels(input.organisationId, input.bookingId, "booking.cancelled");
  await driveWorker();
}

export async function onBookingFinished(input: TriggerInput): Promise<void> {
  // Thank-you fires 3h after `finished` so the guest is past dessert
  // and out the door. The cron sweeper picks this up.
  const at = new Date(Date.now() + 3 * 60 * 60 * 1000);
  await enqueueAllChannels(input.organisationId, input.bookingId, "booking.thank_you", at);
  // Review request fires later (default 24h post-finish) so it doesn't
  // collide with the thank-you and so the guest has slept on the
  // experience. Per-venue toggle + delay live in venues.settings.
  const settings = await loadVenueReviewSettings(input.bookingId);
  if (settings && settings.enabled) {
    const reviewAt = new Date(Date.now() + settings.delayHours * 60 * 60 * 1000);
    await enqueueAllChannels(
      input.organisationId,
      input.bookingId,
      "booking.review_request",
      reviewAt,
    );
  }
  // Don't drive worker — neither message is due for hours.
}

// --- internals ---------------------------------------------------------------

async function scheduleRemindersFor(input: TriggerInput): Promise<void> {
  const { adminDb } = await import("@/lib/server/admin/db");
  const { bookings } = await import("@/lib/db/schema");
  const { eq } = await import("drizzle-orm");
  const [row] = await adminDb()
    .select({ startAt: bookings.startAt })
    .from(bookings)
    .where(eq(bookings.id, input.bookingId))
    .limit(1);
  if (!row) return;

  const startMs = row.startAt.getTime();
  const reminder24h = new Date(startMs - 24 * 60 * 60 * 1000);
  const reminder2h = new Date(startMs - 2 * 60 * 60 * 1000);

  // Don't enqueue retroactive reminders (booking was made within the
  // window). The worker would just send them immediately, which isn't
  // useful — guest already has the confirmation.
  const now = Date.now();
  if (reminder24h.getTime() > now) {
    await enqueueAllChannels(
      input.organisationId,
      input.bookingId,
      "booking.reminder_24h",
      reminder24h,
    );
  }
  if (reminder2h.getTime() > now) {
    await enqueueAllChannels(
      input.organisationId,
      input.bookingId,
      "booking.reminder_2h",
      reminder2h,
    );
  }
}

// Read the per-venue review-request settings from venues.settings JSONB
// via the parent booking. Returns null if the venue/booking is gone
// (caller skips). Defaults: enabled=true, delayHours=24.
async function loadVenueReviewSettings(
  bookingId: string,
): Promise<{ enabled: boolean; delayHours: number } | null> {
  const { adminDb } = await import("@/lib/server/admin/db");
  const { bookings, venues } = await import("@/lib/db/schema");
  const { eq } = await import("drizzle-orm");
  const [row] = await adminDb()
    .select({ settings: venues.settings })
    .from(bookings)
    .innerJoin(venues, eq(venues.id, bookings.venueId))
    .where(eq(bookings.id, bookingId))
    .limit(1);
  if (!row) return null;
  const s = (row.settings ?? {}) as Record<string, unknown>;
  const enabled = s["reviewRequestEnabled"] !== false;
  const raw = s["reviewRequestDelayHours"];
  const allowed = [24, 48, 72] as const;
  const delayHours =
    typeof raw === "number" && (allowed as readonly number[]).includes(raw) ? raw : 24;
  return { enabled, delayHours };
}

async function driveWorker(): Promise<void> {
  try {
    await processNextBatch({ limit: INLINE_DRIVE_LIMIT });
  } catch (err) {
    console.error("[lib/messaging/triggers.ts] inline worker drive failed:", {
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
