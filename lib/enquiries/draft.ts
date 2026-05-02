// Reply-text generator for the AI enquiry handler.
//
// Template-based, NOT LLM-generated. The Bedrock parser tells us
// what the guest asked for; this module assembles the reply from
// fixed copy with extracted fields slotted in. Operator-curated
// language, no model creativity — reduces blast radius if the parser
// hallucinates a field, keeps the legal-review surface tiny, and
// guarantees the human-fallback line per the spec's acceptance
// criteria.
//
// Pure function: takes the parsed enquiry + suggested slots + venue
// context, returns `{ subject, body }`. Caller is responsible for
// encrypting both before persistence.

import type { PublicVenue } from "@/lib/public/venue";

import type { ParsedEnquiry, SuggestedSlot, TimeWindow } from "./types";

// Mandatory line per spec acceptance criteria — "every reply must
// include a human fallback".
const HUMAN_FALLBACK = "Not quite right? Reply to this email and our team will help.";

export type Draft = { subject: string; body: string };

export function generateDraft(input: {
  parsed: ParsedEnquiry;
  slots: ReadonlyArray<SuggestedSlot>;
  venue: Pick<PublicVenue, "name" | "timezone" | "locale">;
}): Draft {
  const { parsed, slots, venue } = input;

  if (parsed.kind === "not_a_booking_request") {
    // Not enough signal to draft a booking-flavoured reply. Send a
    // short generic acknowledgement with the human fallback so the
    // guest can clarify.
    return {
      subject: `Re: your message to ${venue.name}`,
      body: [
        salutation(parsed.guestFirstName),
        ``,
        `Thanks for getting in touch with ${venue.name}. Could you let us know a little more about what you'd like to do — for example, the date, time, or party size if you're hoping to book a table?`,
        ``,
        HUMAN_FALLBACK,
      ].join("\n"),
    };
  }

  // booking_request branch
  const partyLine = formatPartyLine(parsed.partySize);
  const dateLine = formatDateLine(parsed.requestedDate, parsed.requestedTimeWindow, venue.locale);

  const slotsBlock =
    slots.length > 0
      ? [
          ``,
          `Here are the times we have available:`,
          ``,
          ...slots.map((s) => `  • ${formatSlot(s, venue)}`),
          ``,
          `Reply with the time that suits you best and we'll confirm your booking.`,
        ]
      : [
          ``,
          `Unfortunately we don't have anything available at that time. Could you let us know if a different date or time would work? We'll do our best to fit you in.`,
        ];

  return {
    subject: `Re: your booking enquiry at ${venue.name}`,
    body: [
      salutation(parsed.guestFirstName),
      ``,
      `Thanks for your enquiry${partyLine ? ` for ${partyLine}` : ""}${dateLine ? ` ${dateLine}` : ""}.`,
      ...slotsBlock,
      ``,
      HUMAN_FALLBACK,
    ].join("\n"),
  };
}

function salutation(firstName: string | null): string {
  if (firstName && firstName.trim().length > 0) {
    return `Hi ${firstName.trim()},`;
  }
  return `Hi,`;
}

function formatPartyLine(partySize: number | null): string | null {
  if (partySize === null) return null;
  if (partySize === 1) return "a table for 1";
  if (partySize === 2) return "a table for 2";
  return `a table for ${partySize}`;
}

// "on 15 June" + " in the evening" — both halves optional.
function formatDateLine(date: string | null, window: TimeWindow | null, _locale: string): string {
  const parts: string[] = [];
  if (date) parts.push(`on ${formatIsoDate(date)}`);
  if (window) parts.push(formatTimeWindow(window));
  return parts.join(" ");
}

// Plain en-GB rendering: "15 June" / "5 January". Avoids
// `toLocaleString` because it's locale-fragile in tests and we only
// support en-GB at v1.
function formatIsoDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso; // Zod already rejects malformed dates upstream.
  const months = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  return `${d} ${months[m - 1]}`;
}

function formatTimeWindow(window: TimeWindow): string {
  switch (window) {
    case "morning":
      return "in the morning";
    case "lunch":
      return "for lunch";
    case "afternoon":
      return "in the afternoon";
    case "evening":
      return "in the evening";
    case "late":
      return "later in the evening";
  }
}

// "Dinner — 19:30" — operator-readable; the actual confirmation
// flow will translate the wallStart back into a venue-local
// timestamp when the booking is created.
function formatSlot(slot: SuggestedSlot, venue: { name: string }): string {
  void venue;
  return `${slot.serviceName} — ${slot.wallStart}`;
}
