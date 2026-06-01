// Inline triggers — called from booking-create / transition handlers /
// payment webhooks immediately after a state change. Resolves the
// effective channel per the venue's messaging settings + the guest's
// deliverability, enqueues the matching message row(s), and optionally
// drives the worker inline so confirmations land in seconds rather than
// waiting for the next cron.
//
// Each trigger is fire-and-forget at the call site: errors here must
// not block the booking flow that drove them.
//
// Channel + timing now come from venues.settings (Phase 2) via
// parseMessagingSettings + resolveChannel, not hardcoded literals.
// review_request keeps its dedicated settings keys + path.

import "server-only";

import { enqueueMessage } from "./enqueue";
import { processNextBatch } from "./dispatch";
import { resolveChannel, type GuestChannelState } from "./resolve-channels";
import {
  FLOW_EVENT_TEMPLATE,
  parseMessagingSettings,
  type FlowEvent,
  type MessagingSettings,
} from "./venue-settings";

export type TriggerInput = {
  organisationId: string;
  bookingId: string;
};

// Drive the worker for a small number of rows immediately after
// enqueueing. Keeps confirmation messages sub-second on the happy path.
const INLINE_DRIVE_LIMIT = 5;

type TriggerContext = {
  organisationId: string;
  venueId: string;
  startAt: Date;
  settings: MessagingSettings;
  guest: GuestChannelState;
};

// Resolve the channel for an event and enqueue it (if any channel is
// deliverable). Single channel per event — first deliverable in the
// operator's preference order.
async function enqueueEvent(
  ctx: TriggerContext,
  bookingId: string,
  event: FlowEvent,
  scheduleAt?: Date,
): Promise<void> {
  const channel = resolveChannel({
    event,
    venueId: ctx.venueId,
    config: ctx.settings[event],
    guest: ctx.guest,
  });
  if (!channel) return;
  await enqueueMessage({
    organisationId: ctx.organisationId,
    bookingId,
    template: FLOW_EVENT_TEMPLATE[event],
    channel,
    ...(scheduleAt ? { scheduleAt } : {}),
  });
}

export async function onBookingConfirmed(input: TriggerInput): Promise<void> {
  const ctx = await loadTriggerContext(input.bookingId);
  if (!ctx) return;

  await enqueueEvent(ctx, input.bookingId, "confirmation");

  // Schedule the reminders here — cheaper than a cron sweeper hunting
  // for bookings that still need them. The worker's WHERE filters on
  // next_attempt_at <= now() so these sit dormant until due. Timing
  // comes from the venue's settings (defaults 24h / 2h).
  const now = Date.now();
  const startMs = ctx.startAt.getTime();
  const r24 = ctx.settings.reminder_24h.hoursBeforeStart ?? 24;
  const r2 = ctx.settings.reminder_2h.hoursBeforeStart ?? 2;
  const reminder24h = new Date(startMs - r24 * 60 * 60 * 1000);
  const reminder2h = new Date(startMs - r2 * 60 * 60 * 1000);
  // Don't enqueue retroactive reminders (booking made inside the
  // window) — the worker would just fire them immediately, which isn't
  // useful since the guest already has the confirmation.
  if (reminder24h.getTime() > now) {
    await enqueueEvent(ctx, input.bookingId, "reminder_24h", reminder24h);
  }
  if (reminder2h.getTime() > now) {
    await enqueueEvent(ctx, input.bookingId, "reminder_2h", reminder2h);
  }

  await driveWorker();
}

export async function onBookingCancelled(input: TriggerInput): Promise<void> {
  const ctx = await loadTriggerContext(input.bookingId);
  if (!ctx) return;
  await enqueueEvent(ctx, input.bookingId, "cancelled");
  await driveWorker();
}

export async function onBookingFinished(input: TriggerInput): Promise<void> {
  const ctx = await loadTriggerContext(input.bookingId);
  if (!ctx) return;

  // Thank-you fires after `finished` (default 3h) so the guest is past
  // dessert and out the door. The cron sweeper picks this up.
  const thankYouHours = ctx.settings.thank_you.hoursAfterFinish ?? 3;
  const thankYouAt = new Date(Date.now() + thankYouHours * 60 * 60 * 1000);
  await enqueueEvent(ctx, input.bookingId, "thank_you", thankYouAt);

  // Review request keeps its dedicated settings keys + path. Email-only
  // template; dispatch suppresses if the guest opted out of email.
  const review = await loadVenueReviewSettings(input.bookingId);
  if (review && review.enabled && !ctx.guest.erasedAt) {
    const reviewAt = new Date(Date.now() + review.delayHours * 60 * 60 * 1000);
    await enqueueMessage({
      organisationId: ctx.organisationId,
      bookingId: input.bookingId,
      template: "booking.review_request",
      channel: "email",
      scheduleAt: reviewAt,
    });
  }
  // Don't drive worker — neither message is due for hours.
}

// --- internals ---------------------------------------------------------------

async function loadTriggerContext(bookingId: string): Promise<TriggerContext | null> {
  const { adminDb } = await import("@/lib/server/admin/db");
  const { bookings, venues, guests } = await import("@/lib/db/schema");
  const { eq } = await import("drizzle-orm");
  const [row] = await adminDb()
    .select({
      organisationId: bookings.organisationId,
      startAt: bookings.startAt,
      venueId: venues.id,
      settings: venues.settings,
      hasPhone: guests.phoneCipher,
      erasedAt: guests.erasedAt,
      emailInvalid: guests.emailInvalid,
      phoneInvalid: guests.phoneInvalid,
      whatsappInvalid: guests.whatsappInvalid,
      emailUnsubscribedVenues: guests.emailUnsubscribedVenues,
      smsUnsubscribedVenues: guests.smsUnsubscribedVenues,
      whatsappUnsubscribedVenues: guests.whatsappUnsubscribedVenues,
    })
    .from(bookings)
    .innerJoin(venues, eq(venues.id, bookings.venueId))
    .innerJoin(guests, eq(guests.id, bookings.guestId))
    .where(eq(bookings.id, bookingId))
    .limit(1);
  if (!row) return null;

  return {
    organisationId: row.organisationId,
    venueId: row.venueId,
    startAt: row.startAt,
    settings: parseMessagingSettings(row.settings),
    guest: {
      hasPhone: row.hasPhone !== null,
      erasedAt: row.erasedAt,
      emailInvalid: row.emailInvalid,
      phoneInvalid: row.phoneInvalid,
      whatsappInvalid: row.whatsappInvalid,
      emailUnsubscribedVenues: row.emailUnsubscribedVenues,
      smsUnsubscribedVenues: row.smsUnsubscribedVenues,
      whatsappUnsubscribedVenues: row.whatsappUnsubscribedVenues,
    },
  };
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
