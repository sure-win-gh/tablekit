// Boundary helper that prepares a runtime error for persistence in
// `enquiries.error`. Same shape as `lib/import/runner/sanitise-
// error.ts` — the column is NOT encrypted, so anything we store
// here is at-rest plaintext for the operator to see, which means
// any PII echoed by Postgres / Bedrock / driver errors must be
// scrubbed before it ever lands.
//
// The sanitiser is conservative — output is bounded to 480 chars
// (DB CHECK is 500) and stripped of:
//
//   1. Postgres detail tuples — `(col)=(value)` → `(col)=(<redacted>)`.
//      Structural; runs first so the value is unconditionally
//      redacted regardless of what's inside.
//   2. Email-shaped substrings.
//   3. UK postcodes + NI numbers (project operates in the UK).
//   4. Long digit runs (likely phone numbers).
//
// Counts and the `enquiries.id` carry the real signal — the message
// is hint-text for a human glance.

const MAX_CHARS = 480;

const PG_DETAIL_VALUE_RE = /\(([^)]+)\)=\(([^)]+)\)/g;
const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/g;
const UK_POSTCODE_RE = /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/gi;
const NI_NUMBER_RE = /\b[A-CEGHJ-PR-TW-Z]{2}\d{6}[A-D]?\b/gi;
const PHONE_RE = /\+?\d[\d\s\-()]{6,}/g;

export function sanitiseEnquiryError(input: unknown): string {
  const raw =
    input instanceof Error ? input.message : typeof input === "string" ? input : "Unknown error.";

  // Order matters: PG_DETAIL first (structural — claims parens'd
  // values regardless of content), then format-specific passes
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
