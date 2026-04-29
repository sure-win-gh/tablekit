import type { BookingStatus } from "./state";

// Shared payload for the booking detail dialog. Both the timeline view
// and the bookings list construct this shape so the dialog itself
// stays surface-agnostic. `durationMinutes` is precomputed by the
// caller (timeline reads it from its 15-min grid; the list reads from
// startAt/endAt) so the dialog doesn't need to parse wall-clock
// strings.
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
  tableId: string;
  tableLabel: string;
  areaId: string;
  refundable: boolean;
  cardHold: boolean;
  noShowOutcome: "captured" | "failed" | null;
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
