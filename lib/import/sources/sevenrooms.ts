// SevenRooms "Clients" CSV export.
//
// US-centric layout — phone-number columns are split into "Phone
// Number Country Code" + "Phone Number" in some exports. We map
// the local digits column; cross-region phone normalisation is the
// runner's job.

import type { SourceAdapter } from "./types";

export const sevenrooms: SourceAdapter = {
  source: "sevenrooms",
  // "VIP Status" + "Tags" together are characteristic — neither
  // OpenTable nor ResDiary surfaces both in the same export.
  signatureHeaders: ["First Name", "Last Name", "Email", "VIP Status"],
  candidates: {
    firstName: ["First Name"],
    lastName: ["Last Name"],
    email: ["Email"],
    phone: ["Phone Number", "Phone"],
    notes: ["Notes", "Client Notes"],
  },
};
