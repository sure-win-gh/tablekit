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
  // Tokenised public review-submission URL. Built unconditionally;
  // only `booking.review_request` actually renders it.
  reviewUrl: string;
  // Optional fields some templates need:
  cancellationReason?: string | null;
  // For card-hold no-show captures; rendered in cancelled emails when
  // a deposit was forfeited.
  forfeitedAmountMinor?: number;
  // Decrypted operator reply text — populated only for the
  // `review.operator_reply` template; null/undefined elsewhere so
  // load-context doesn't pay the per-message decrypt for no reason.
  operatorReplyText?: string | null;
  // Decrypted recovery-offer message — same shape as
  // operatorReplyText but lives in reviews.recovery_message_cipher.
  // Populated only for the `review.recovery_offer` template.
  recoveryMessageText?: string | null;
};

export type RenderedEmail = {
  subject: string;
  html: string;
  text: string;
};

export type RenderedSms = {
  body: string;
};
