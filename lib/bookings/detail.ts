import type { BookingStatus } from "./state";

// Shared payload for the booking detail dialog. Both the timeline view
// and the bookings list construct this shape so the dialog itself
// stays surface-agnostic. `durationMinutes` is precomputed by the
// caller (timeline reads it from its 15-min grid; the list reads from
// startAt/endAt) so the dialog doesn't need to parse wall-clock
// strings.
//
// The "enrichment" fields below — guestTags, guestNotes, dietaryNotes,
// highChairs, priorVisits — are populated by
// lib/bookings/enriched-detail.ts. Callers should decrypt + count once
// at the page boundary, not in the dialog itself.
export type BookingDetailPayload = {
  id: string;
  status: BookingStatus;
  wallStart: string;
  wallEnd: string;
  durationMinutes: number;
  guestId: string;
  guestFirstName: string;
  partySize: number;
  notes: string | null;
  serviceName: string;
  // Null when the booking has no table assigned (e.g. cancelled — a DB
  // trigger frees the tables). The list surface can open the dialog for
  // these; the timeline always passes a real table.
  tableId: string | null;
  tableLabel: string | null;
  areaId: string;
  refundable: boolean;
  cardHold: boolean;
  noShowOutcome: "captured" | "failed" | null;
  // Seating-moment enrichment. See lib/bookings/enriched-detail.ts.
  guestTags: string[];
  guestNotes: string | null;
  highChairs: number;
  dietaryNotes: string | null;
  priorVisits: number;
};

// Subset of the enriched fields needed by the at-a-glance badges. Used
// by both the booking detail dialog and the surface-level row badges
// so the call sites that don't need the full BookingDetailPayload can
// still render badges without rebuilding the shape.
export type GuestEnrichment = {
  guestTags: string[];
  guestNotes: string | null;
  highChairs: number;
  dietaryNotes: string | null;
  priorVisits: number;
};

// Minimal venue-table row shape the dialog needs to populate the
// "move table" select. Both the timeline page and the bookings list
// already load this — they just rename the type.
export type VenueTableForDetail = {
  id: string;
  label: string;
  areaId: string;
  areaName: string;
  maxCover: number;
};
