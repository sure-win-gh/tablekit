// Shared Zod primitives for the public v1 API.
//
// One place for the input shapes that repeat across route handlers, so
// four hand-rolled copies of a UUID regex can't drift apart. Keep these
// deliberately bug-compatible with the checks they replaced:
//
//   • zUuid uses the permissive hyphenated-hex regex the routes always
//     used (case-insensitive, no version/variant bits) — NOT
//     z.string().uuid(), which is stricter and would start rejecting
//     ids that previously passed.
//   • zPartySizeParam keeps Number.parseInt semantics ("5abc" → 5) so
//     query-string parsing behaves exactly as before.

import { z } from "zod";

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** UUID in a path segment, query param, or JSON body. */
export const zUuid = z.string().regex(UUID_RE);

/** Calendar date as yyyy-mm-dd (no range semantics — shape only). */
export const zIsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Party size as a JSON number (widget/REST bodies). */
export const zPartySize = z.number().int().min(1).max(20);

/**
 * Party size arriving as a query-string value. Preprocesses with
 * Number.parseInt to stay bug-compatible with the manual parsing it
 * replaced; the numeric bounds match zPartySize.
 */
export const zPartySizeParam = z.preprocess(
  (v) => (typeof v === "string" ? Number.parseInt(v, 10) : v),
  zPartySize,
);
