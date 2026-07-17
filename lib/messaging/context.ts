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
  // Event-ticket purchases (source='event'): per-tier breakdown + total,
  // rendered in the confirmation email. Absent for standard bookings.
  // docs/specs/special-events.md Phase 2 polish.
  eventTickets?: {
    lines: { name: string; quantity: number; unitPriceMinor: number }[];
    totalMinor: number;
  };
  // Per-venue branding (Phase 2). Loaded from venues.settings.branding;
  // undefined falls back to the shipped neutral layout. Applies to email
  // only — SMS/WhatsApp stay plain. Explicit `| undefined` so it can be
  // assigned the parser's result under exactOptionalPropertyTypes.
  branding?: VenueBranding | undefined;
};

export type VenueBranding = {
  logoUrl?: string | null;
  brandColour?: string | null; // hex, e.g. "#c2410c"
  signature?: string | null; // operator sign-off line(s)
  replyTo?: string | null;
  // Widget-only: corner treatment for the booking surfaces. Ignored by
  // the email layout. Plus-gated at render time, not stored-gated.
  cornerStyle?: "rounded" | "sharp" | null;
};

export type RenderedEmail = {
  subject: string;
  html: string;
  text: string;
};

export type RenderedSms = {
  body: string;
};

// WhatsApp renders like SMS (plain body for the session-window path)
// but may also carry an approved-template reference for the
// business-initiated path. The dispatch layer prefers contentSid when
// present; `body` is the freeform/session fallback and the value we
// log-render in previews.
export type RenderedWhatsApp = {
  body: string;
  contentSid?: string;
  contentVariables?: Record<string, string>;
};
