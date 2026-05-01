// ResDiary "Customer" CSV export.
//
// ResDiary's customer-export columns are prefixed with "Customer"
// — a useful signature because no other supported source uses that
// pattern.

import type { SourceAdapter } from "./types";

export const resdiary: SourceAdapter = {
  source: "resdiary",
  signatureHeaders: ["Customer First Name", "Customer Email"],
  candidates: {
    firstName: ["Customer First Name", "FirstName", "First Name"],
    lastName: ["Customer Surname", "Surname", "Last Name"],
    email: ["Customer Email", "EmailAddress", "Email"],
    phone: ["Customer Phone", "Phone Number", "Phone"],
    notes: ["Customer Notes", "Notes"],
  },
};
