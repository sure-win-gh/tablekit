// Shared types for the AI enquiry pipeline.
//
// `ParsedEnquirySchema` is the source of truth for what the LLM
// parser is allowed to emit. The model's structured-output contract
// bounds what can come out at all; Zod re-validates at runtime as
// defence in depth. The runner persists `ParsedEnquiry` (serialised
// to JSON, then envelope-encrypted into `enquiries.parsed_cipher`).

import { z } from "zod";

export const ENQUIRY_STATUSES = [
  "received",
  "parsing",
  "draft_ready",
  "replied",
  "failed",
  "discarded",
] as const;
export type EnquiryStatus = (typeof ENQUIRY_STATUSES)[number];

// Buckets for "evening", "lunch service", etc. Specific times like
// "8pm" map to the nearest window in the parser's system prompt;
// the runner's draft.ts then translates the window back into one
// of the venue's actual service start times.
export const TIME_WINDOWS = ["morning", "lunch", "afternoon", "evening", "late"] as const;
export type TimeWindow = (typeof TIME_WINDOWS)[number];

// One ISO yyyy-mm-dd string. Date-only — the time is captured by
// `requestedTimeWindow` separately.
const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "requestedDate must be ISO yyyy-mm-dd");

// `specialRequests` may capture special-category data under GDPR
// Article 9 (dietary requirements implying health, accessibility
// implying disability). Encryption is enforced via parent
// `parsed_cipher`; this cap bounds the Article 9 surface so an
// attacker can't dump pages of free-text PII through a single field.
const SPECIAL_REQUESTS_MAX_TOTAL_CHARS = 800;

export const ParsedEnquirySchema = z.object({
  // The most important field: was this an actual booking enquiry, or
  // some other kind of email (auto-reply, forward, marketing,
  // unrelated question)? The runner only drafts replies for
  // `booking_request` rows; `not_a_booking_request` jobs land in
  // the inbox marked `discarded` so the operator can review.
  kind: z.enum(["booking_request", "not_a_booking_request"]),
  partySize: z.number().int().positive().max(50).nullable(),
  requestedDate: ISO_DATE.nullable(),
  requestedTimeWindow: z.enum(TIME_WINDOWS).nullable(),
  // Short operator-relevant notes (dietary, occasion, accessibility,
  // seating). NOT the date/time/party — those have their own fields.
  // Capped at 5 items × 280 chars per item, plus a total-char cap
  // (Article 9 surface bound, see above).
  specialRequests: z
    .array(z.string().max(280))
    .max(5)
    .refine(
      (arr) => arr.reduce((n, s) => n + s.length, 0) <= SPECIAL_REQUESTS_MAX_TOTAL_CHARS,
      `specialRequests total length must be ≤ ${SPECIAL_REQUESTS_MAX_TOTAL_CHARS} chars`,
    ),
  // Names go through `encryptPii` when persisted (parsed_cipher is
  // the parent column on enquiries). Honorifics stripped at parse
  // time per the system-prompt rule.
  guestFirstName: z.string().max(60).nullable(),
  guestLastName: z.string().max(60).nullable(),
});
export type ParsedEnquiry = z.infer<typeof ParsedEnquirySchema>;

// Plaintext jsonb on `enquiries.suggested_slots` — slot times only,
// no PII. Shape matches what `lib/bookings/availability.ts:findSlots`
// returns, projected for the operator inbox UI.
export type SuggestedSlot = {
  serviceId: string;
  serviceName: string;
  startAt: string; // ISO timestamp (UTC)
  endAt: string; // ISO timestamp (UTC)
  wallStart: string; // venue-local HH:MM for display
};
