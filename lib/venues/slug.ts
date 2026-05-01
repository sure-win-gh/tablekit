// Pure helpers for venue slug validation + UUID-vs-slug discrimination.
//
// Lives in lib/ so unit tests + the public route + the dashboard
// settings action can all share one source of truth. The DB enforces
// the same shape via a CHECK constraint — these are belt and braces.

// 3–60 chars, lowercase letters / digits / hyphens.
// Must start + end with an alphanumeric (no leading / trailing hyphens).
// Internal doubles are technically allowed by this regex; the validator
// below rejects them explicitly so error messages can be precise.
export const SLUG_REGEX = /^[a-z0-9](?:[a-z0-9-]{1,58}[a-z0-9])?$/;

// Top-level routes that already exist under app/. A slug matching one
// of these would shadow the route in the dual-routing matcher. Keep
// this in sync with the app/ tree.
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  "embed",
  "book",
  "widget.js",
  "dashboard",
  "api",
  "_next",
  "login",
  "signup",
  "admin",
  "legal",
  "privacy",
  "security",
  "review",
  "unsubscribe",
  "auth",
]);

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function looksLikeUuid(s: string): boolean {
  return UUID_REGEX.test(s);
}

export type SlugValidation =
  | { ok: true; slug: string }
  | { ok: false; reason: "format"; message: string }
  | { ok: false; reason: "reserved"; message: string };

// Validate + normalise. Lowercases the input first so "Jane-Cafe"
// becomes "jane-cafe" before the regex check (the citext column does
// case-insensitive uniqueness anyway, but we want the canonical form
// stored).
export function validateSlug(input: string): SlugValidation {
  const normalised = input.trim().toLowerCase();
  if (normalised.length < 3 || normalised.length > 60) {
    return {
      ok: false,
      reason: "format",
      message: "Slug must be 3–60 characters.",
    };
  }
  if (!SLUG_REGEX.test(normalised)) {
    return {
      ok: false,
      reason: "format",
      message: "Use lowercase letters, digits and single hyphens only.",
    };
  }
  if (normalised.includes("--")) {
    return {
      ok: false,
      reason: "format",
      message: "No consecutive hyphens.",
    };
  }
  if (RESERVED_SLUGS.has(normalised)) {
    return {
      ok: false,
      reason: "reserved",
      message: "That slug is reserved.",
    };
  }
  return { ok: true, slug: normalised };
}
