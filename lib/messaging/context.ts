// Booking-shaped context that every template (email + SMS) takes.
// Built once per send by the dispatch layer (lib/messaging/dispatch.ts)
// and passed to the appropriate renderer.
//
// `unsubscribeUrl` is per-(guest, venue, channel) so the per-venue
// unsubscribe semantics in the spec hold.
//
// `startAtLocal` / `endAtLocal` are pre-formatted in the venue's
// timezone + locale by the dispatch layer — keeps templates dumb.

import "server-only";

export type MessageBookingContext = {
  bookingId: string;
  reference: string;
  guestFirstName: string;
  partySize: number;
  startAtLocal: string; // e.g. "Mon 1 May 2026, 7:00 PM"
  endAtLocal: string;
  venueName: string;
  venueLocale: string; // e.g. "en-GB"
  serviceName: string;
  notes: string | null;
  unsubscribeUrl: string;
  // Optional fields some templates need:
  cancellationReason?: string | null;
  // For card-hold no-show captures; rendered in cancelled emails when
  // a deposit was forfeited.
  forfeitedAmountMinor?: number;
};

export type RenderedEmail = {
  subject: string;
  html: string;
  text: string;
};

export type RenderedSms = {
  body: string;
};
