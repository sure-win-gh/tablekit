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

import { bookings, guests, services, venues } from "@/lib/db/schema";
import { decryptPii, type Ciphertext } from "@/lib/security/crypto";
import { adminDb } from "@/lib/server/admin/db";
import { formatVenueDateLong, formatVenueTime } from "@/lib/bookings/time";

import type { MessageBookingContext } from "./context";
import type { MessageChannel } from "./registry";
import { reviewUrl } from "./review-tokens";
import { unsubscribeUrl } from "./tokens";

export type LoadContextInput = {
  bookingId: string;
  channel: MessageChannel;
  appUrl: string;
};

export type LoadContextResult =
  | { ok: true; ctx: MessageBookingContext; recipient: string }
  | { ok: false; reason: "booking-not-found" | "missing-recipient" | "decrypt-failed" };

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

  return { ok: true, ctx, recipient };
}

// Short, human-friendly reference derived from the booking id. Matches
// the public widget's bookingReference() shape — re-derived here to
// avoid pulling lib/public/captcha into the messaging surface.
function bookingReference(bookingId: string): string {
  return bookingId.slice(0, 8).toUpperCase();
}
