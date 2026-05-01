// The runner relies on `lib/import/normalize.ts` and the private
// normalisation in `lib/security/crypto.ts:hashForLookup` agreeing.
// If they ever drift, the runner will hash a candidate's email
// differently from the existing-hashes the writer fetched from the
// DB — and dedupe-against-existing silently lets duplicates through.
//
// This is the "load-bearing" cross-check the code-reviewer asked for
// in PR2. It runs `hashForLookup(normaliseEmail(x), 'email')` against
// `hashForLookup(x, 'email')` over a fuzz set; both must agree.

import { describe, expect, it } from "vitest";

import { normaliseEmail, normalisePhone } from "@/lib/import/normalize";
import { hashForLookup } from "@/lib/security/crypto";

const EMAIL_FUZZ = [
  "jane@example.com",
  "Jane@Example.com",
  "  jane@example.com  ",
  "JANE@EXAMPLE.COM",
  "jane.doe+bookings@example.co.uk",
  "  Jane.Doe+BOOKINGS@Example.Co.UK  ",
  "j+a@x.io",
  "a@b.co",
];

const PHONE_FUZZ = [
  "+44 7700 900123",
  "+44-7700-900123",
  "(+44) 7700 900 123",
  "  +44  7700  900 123  ",
  "07700900123",
  "07700-900123",
];

describe("normalisedHashesAgree — email", () => {
  it.each(EMAIL_FUZZ)(
    "hashForLookup(normaliseEmail(%s), 'email') === hashForLookup(%s, 'email')",
    (input) => {
      const a = hashForLookup(normaliseEmail(input), "email");
      const b = hashForLookup(input, "email");
      expect(a).toBe(b);
    },
  );
});

describe("normalisedHashesAgree — phone", () => {
  it.each(PHONE_FUZZ)(
    "hashForLookup(normalisePhone(%s), 'phone') === hashForLookup(%s, 'phone')",
    (input) => {
      const a = hashForLookup(normalisePhone(input), "phone");
      const b = hashForLookup(input, "phone");
      expect(a).toBe(b);
    },
  );
});
