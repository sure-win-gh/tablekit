// Header-name → guest-field heuristic. Used by the mapping form to
// pre-fill its dropdowns; operators can override every guess.
//
// PR5 (format adapters) will wrap this with adapter-specific
// presets — OpenTable's "Email Address" header, ResDiary's
// "Customer Email", etc. Until then, the matchers below cover the
// generic-CSV path. The function is pure + framework-free so PR5
// can compose it freely.

import type { MappedField } from "./types";

const SUGGESTIONS: Record<MappedField, readonly string[]> = {
  firstName: ["first name", "firstname", "given name", "forename", "name"],
  lastName: ["last name", "lastname", "surname", "family name"],
  email: ["email", "e-mail", "email address"],
  phone: ["phone", "mobile", "telephone", "phone number", "mobile number"],
  notes: ["notes", "comments", "preferences"],
};

// Lowercase + drop everything that isn't a-z/0-9 so "First Name",
// "first_name", "FIRST-NAME" all collapse to the same key.
function normalise(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function suggestMapping(
  headers: ReadonlyArray<string>,
): Partial<Record<MappedField, string>> {
  const byNormalised = new Map(headers.map((h) => [normalise(h), h]));
  const out: Partial<Record<MappedField, string>> = {};
  for (const field of Object.keys(SUGGESTIONS) as MappedField[]) {
    for (const candidate of SUGGESTIONS[field]) {
      const found = byNormalised.get(normalise(candidate));
      if (found) {
        out[field] = found;
        break;
      }
    }
  }
  return out;
}
