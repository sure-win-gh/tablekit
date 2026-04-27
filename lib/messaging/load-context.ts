// Build a MessageBookingContext for a given booking.
//
// Called by the dispatch worker (lib/messaging/dispatch.ts) once per
// claimed message. Loads booking + service + venue + guest in one
// query (innerJoin), decrypts the guest's email (lib/security/crypto.ts)
// for the `to` address, formats start/end in the venue's timezone +
// locale, and signs the per-(guest, venue, channel) unsubscribe URL.
//
// Email decryption is the only PII-sensitive step here. Per the
// playbook: never log it, never include it in error metadata. Errors
// from decryption surface as "could not load context" — caller logs
// only the booking_id.

import "server-only";

import { eq } from "drizzle-orm";

import { bookings, guests, reviews, services, venues } from "@/lib/db/schema";
import { decryptPii, type Ciphertext } from "@/lib/security/crypto";
import { adminDb } from "@/lib/server/admin/db";
import { formatVenueDateLong, formatVenueTime } from "@/lib/bookings/time";

import type { MessageBookingContext } from "./context";
import type { MessageChannel, MessageTemplate } from "./registry";
import { reviewUrl } from "./review-tokens";
import { unsubscribeUrl } from "./tokens";

export type LoadContextInput = {
  bookingId: string;
  channel: MessageChannel;
  appUrl: string;
  // Threaded so templates with extra context (operator reply text,
  // future per-template fields) can opt into a second decrypt without
  // every message paying the cost.
  template: MessageTemplate;
};

export type LoadContextResult =
  | { ok: true; ctx: MessageBookingContext; recipient: string }
  | {
      ok: false;
      reason:
        | "booking-not-found"
        | "missing-recipient"
        | "decrypt-failed"
        | "review-response-missing";
    };

export async function loadMessageContext(input: LoadContextInput): Promise<LoadContextResult> {
  const db = adminDb();
  const [row] = await db
    .select({
      bookingId: bookings.id,
      organisationId: bookings.organisationId,
      partySize: bookings.partySize,
      startAt: bookings.startAt,
      endAt: bookings.endAt,
      notes: bookings.notes,
      cancelledReason: bookings.cancelledReason,
      serviceName: services.name,
      venueId: venues.id,
      venueName: venues.name,
      venueLocale: venues.locale,
      venueTimezone: venues.timezone,
      guestId: guests.id,
      guestFirstName: guests.firstName,
      guestEmailCipher: guests.emailCipher,
      guestPhoneCipher: guests.phoneCipher,
      guestEmailInvalid: guests.emailInvalid,
      guestPhoneInvalid: guests.phoneInvalid,
      guestEmailUnsubVenues: guests.emailUnsubscribedVenues,
      guestSmsUnsubVenues: guests.smsUnsubscribedVenues,
    })
    .from(bookings)
    .innerJoin(services, eq(services.id, bookings.serviceId))
    .innerJoin(venues, eq(venues.id, bookings.venueId))
    .innerJoin(guests, eq(guests.id, bookings.guestId))
    .where(eq(bookings.id, input.bookingId))
    .limit(1);

  if (!row) return { ok: false, reason: "booking-not-found" };

  // Per-channel suppression check — don't even build the context if
  // we shouldn't send. Lets the worker mark the row 'failed' with a
  // clear reason without wasting a render cycle.
  if (input.channel === "email") {
    if (row.guestEmailInvalid) return { ok: false, reason: "missing-recipient" };
    if (row.guestEmailUnsubVenues.includes(row.venueId)) {
      return { ok: false, reason: "missing-recipient" };
    }
  } else {
    if (row.guestPhoneInvalid || !row.guestPhoneCipher) {
      return { ok: false, reason: "missing-recipient" };
    }
    if (row.guestSmsUnsubVenues.includes(row.venueId)) {
      return { ok: false, reason: "missing-recipient" };
    }
  }

  let recipient: string;
  try {
    recipient =
      input.channel === "email"
        ? await decryptPii(row.organisationId, row.guestEmailCipher as Ciphertext)
        : await decryptPii(row.organisationId, row.guestPhoneCipher as Ciphertext);
  } catch {
    return { ok: false, reason: "decrypt-failed" };
  }

  const tz = { timezone: row.venueTimezone };
  const startAtLocal = `${formatVenueDateLong(row.startAt, tz)}, ${formatVenueTime(row.startAt, tz)}`;
  const endAtLocal = `${formatVenueDateLong(row.endAt, tz)}, ${formatVenueTime(row.endAt, tz)}`;

  const ctx: MessageBookingContext = {
    bookingId: row.bookingId,
    reference: bookingReference(row.bookingId),
    guestFirstName: row.guestFirstName,
    partySize: row.partySize,
    startAtLocal,
    endAtLocal,
    venueName: row.venueName,
    venueLocale: row.venueLocale,
    serviceName: row.serviceName,
    notes: row.notes,
    cancellationReason: row.cancelledReason,
    unsubscribeUrl: unsubscribeUrl(input.appUrl, {
      guestId: row.guestId,
      venueId: row.venueId,
      channel: input.channel,
    }),
    reviewUrl: reviewUrl(input.appUrl, { bookingId: row.bookingId }),
  };

  // Per-template extra loads. Kept in load-context (rather than the
  // template render step) so the whole context is final by the time
  // renderForChannel runs and templates stay pure.
  //
  // Suppression note: the per-venue email unsubscribe check above
  // (line 75-78) already short-circuits before this branch runs, so
  // the operator-reply template honours the same per-venue opt-out as
  // every other email — load-bearing for our LIA in gdpr.md.
  if (input.template === "review.operator_reply") {
    // Lookup keyed on bookingId because Phase 2 has the
    // reviews_booking_id_unique constraint. If we ever support
    // multiple reviews per booking, thread the review id through
    // enqueue metadata.
    const [rev] = await db
      .select({ responseCipher: reviews.responseCipher })
      .from(reviews)
      .where(eq(reviews.bookingId, input.bookingId))
      .limit(1);
    // Refuse to send a stub email — if the cipher is gone (review
    // deleted or never written), mark the message failed instead of
    // mailing the guest with an empty body.
    if (!rev?.responseCipher) {
      return { ok: false, reason: "review-response-missing" };
    }
    try {
      ctx.operatorReplyText = await decryptPii(
        row.organisationId,
        rev.responseCipher as Ciphertext,
      );
    } catch {
      // Bare catch is deliberate — node-crypto error messages can
      // include base64 cipher fragments and we don't want those in
      // logs/audit.
      return { ok: false, reason: "decrypt-failed" };
    }
  }

  return { ok: true, ctx, recipient };
}

// Short, human-friendly reference derived from the booking id. Matches
// the public widget's bookingReference() shape — re-derived here to
// avoid pulling lib/public/captcha into the messaging surface.
function bookingReference(bookingId: string): string {
  return bookingId.slice(0, 8).toUpperCase();
}
