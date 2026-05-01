// Boundary helper that prepares a runtime error for persistence in
// `import_jobs.error`. The column is NOT encrypted, so anything we
// store here is at-rest plaintext for the operator to see — which
// means PII echoes that Postgres / drivers casually include in error
// messages must be scrubbed before they ever land.
//
// Two sources of leakage we know about:
//
//   1. Postgres unique-violation messages quote the offending value:
//        "duplicate key value violates unique constraint
//         (email_hash)=(<hex hash>)"
//      The hex hash isn't PII strictly, but stripping it is cheap and
//      keeps the column shape predictable.
//
//   2. Validation-layer errors that include user input verbatim. We
//      don't write any today, but a future contributor easily could.
//
// Output is bounded to 480 chars (DB CHECK is 500) and stripped of
// the obvious patterns. Counts and the `import_jobs.id` carry the
// real signal — the message is hint-text for a human glance.

const MAX_CHARS = 480;

// (column)=(value) → (column)=(<redacted>). Captures the parens-
// delimited value Postgres emits in detail messages. MUST run first
// — the structural pattern unconditionally redacts whatever's
// between the inner parens, including names that no other regex
// would catch.
const PG_DETAIL_VALUE_RE = /\(([^)]+)\)=\(([^)]+)\)/g;

// Email-shaped substrings — replaced wholesale with a placeholder.
// Loose match — same shape as `isPlausibleEmail`'s regex but global.
const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/g;

// UK postcode. Matches the format on gov.uk's bulk-data spec.
const UK_POSTCODE_RE = /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/gi;

// UK National Insurance number — two letters (excluding the chars
// HMRC reserves), six digits, optional final letter A–D.
const NI_NUMBER_RE = /\b[A-CEGHJ-PR-TW-Z]{2}\d{6}[A-D]?\b/gi;

// Long digit runs — likely phone numbers in operator-formatted
// reports. 7+ consecutive digits (with optional separators) trips it.
const PHONE_RE = /\+?\d[\d\s\-()]{6,}/g;

export function sanitiseImportError(input: unknown): string {
  const raw =
    input instanceof Error ? input.message : typeof input === "string" ? input : "Unknown error.";

  // Order matters: PG_DETAIL first (structural — claims parens'd
  // values regardless of content), then the format-specific passes
  // sweep what's left in the free-text portion.
  const scrubbed = raw
    .replace(PG_DETAIL_VALUE_RE, "($1)=(<redacted>)")
    .replace(EMAIL_RE, "<email>")
    .replace(NI_NUMBER_RE, "<ni>")
    .replace(UK_POSTCODE_RE, "<postcode>")
    .replace(PHONE_RE, "<phone>");

  if (scrubbed.length <= MAX_CHARS) return scrubbed;
  return `${scrubbed.slice(0, MAX_CHARS - 1)}…`;
}
