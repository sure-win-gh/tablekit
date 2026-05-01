// OpenTable Guest Center "Guests" CSV export.
//
// Fields below are taken from the public-facing export schema. If a
// future version of OpenTable changes column naming, treat that as
// a schema change here — bump and re-test against a sample export.

import type { SourceAdapter } from "./types";

export const opentable: SourceAdapter = {
  source: "opentable",
  // Distinctive enough to disambiguate from ResDiary / SevenRooms
  // — OpenTable consistently uses "Reservation" as a prefix on
  // booking-side columns, plus the canonical "First Name" pair.
  signatureHeaders: ["First Name", "Last Name", "Email", "Reservation Date"],
  candidates: {
    firstName: ["First Name"],
    lastName: ["Last Name"],
    email: ["Email"],
    phone: ["Phone", "Phone Number"],
    notes: ["Notes", "Reservation Notes"],
  },
};
