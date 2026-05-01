// Email + phone normalisation for the import pipeline.
//
// These rules mirror `lib/security/crypto.ts`'s private `normalise()`
// helper used by `hashForLookup()`. Duplicated here on purpose: PR2 is
// dependency-free, and the rules are short enough that drift is
// catchable by the `normalisedHashesAgree` integration check in PR3.

// 3 chars min so a single-letter local part is allowed but blank /
// trivially short isn't; 254 is the RFC 5321 ceiling.
const EMAIL_MIN = 3;
const EMAIL_MAX = 254;

// "Looks like an email" — deliberately loose. The runner will hash +
// dedupe, and the operator's own data is the source of truth. We
// reject only the obviously-malformed.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normaliseEmail(input: string): string {
  return input.trim().toLowerCase();
}

export function isPlausibleEmail(input: string): boolean {
  if (input.length < EMAIL_MIN || input.length > EMAIL_MAX) return false;
  return EMAIL_RE.test(input);
}

// Strip everything that isn't a digit. Plus signs, spaces, dashes,
// parentheses all go. Keeps the import dedupe key stable across
// "+44 7700 900123" / "07700-900123" / "(0)7700 900 123".
export function normalisePhone(input: string): string {
  return input.replace(/\D+/g, "");
}
