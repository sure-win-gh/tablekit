// Validation for the per-guest "tags" surface on the seating-moment
// enrichment. Tags are plaintext (text[]) and surface to every host
// in the org, so the only PII guard we can offer is at the input
// boundary: reject obvious email + phone patterns before they leave
// the form. The encrypted notes_cipher field carries the
// special-category guest data; tags are intended for short, neutral
// labels (VIP, allergy:nuts, loud-party).

export const MAX_TAGS = 20;
export const MAX_TAG_LENGTH = 32;

const TAG_RE = /^[\x20-\x7e]{1,32}$/;
const EMAIL_LIKE_RE = /@/;
const DIGITS_RE = /\d{6,}/;

export type TagValidationResult =
  | { ok: true; tags: string[] }
  | { ok: false; reason: "too-many" | "bad-shape" | "looks-like-pii"; offending?: string };

export function parseAndValidateTags(raw: string): TagValidationResult {
  const split = raw
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  if (split.length > MAX_TAGS) return { ok: false, reason: "too-many" };
  for (const t of split) {
    if (!TAG_RE.test(t)) return { ok: false, reason: "bad-shape", offending: t };
    if (EMAIL_LIKE_RE.test(t) || DIGITS_RE.test(t)) {
      return { ok: false, reason: "looks-like-pii", offending: t };
    }
  }

  return { ok: true, tags: Array.from(new Set(split)) };
}
