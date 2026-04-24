// Zod input schema for guest upsert.
//
// Strict at the boundary — callers hand us raw user input (eventually
// from the widget); we normalise + validate here so `upsertGuest` can
// assume every field is already trimmed, lower-cased where relevant,
// and length-bounded.

import { z } from "zod";

// UK-first validation but not UK-only. We accept any E.164-ish string
// but strip non-digits for the hash in the crypto layer. Library-free
// on purpose — libphonenumber is 300kB we don't need yet.
const phoneRegex = /^\+?[0-9()\-\s]{7,20}$/;

export const upsertGuestInput = z.object({
  firstName: z
    .string()
    .trim()
    .min(1, "First name is required")
    .max(80, "First name too long"),
  // Empty string allowed for last name — cafe walk-ins often give
  // first name only. Stored as an encrypted empty string so the column
  // stays NOT NULL.
  lastName: z.string().trim().max(80, "Last name too long").default(""),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email("Enter a valid email address")
    .max(200, "Email too long"),
  phone: z
    .string()
    .trim()
    .regex(phoneRegex, "Enter a valid phone number")
    .max(40, "Phone number too long")
    .optional(),
  // ISO timestamp from the dashboard tick-box. Callers pass new Date()
  // or leave undefined.
  marketingConsentAt: z.date().optional(),
});

// The parsed output (defaults filled in). Use this when reading
// from a safeParse / parse result.
export type UpsertGuestInput = z.infer<typeof upsertGuestInput>;

// The raw input callers hand to upsertGuest. `lastName` is optional
// because the Zod default fills it in; the output type above has it
// required. TypeScript needs both sides.
export type UpsertGuestRawInput = z.input<typeof upsertGuestInput>;
