// Header-name → guest-field heuristic. Used by the mapping form to
// pre-fill its dropdowns; operators can override every guess.
//
// When a `source` is supplied AND we have an adapter for it, the
// adapter's per-field candidates take priority — they're more
// specific than the generic list. Fall back to the generic
// candidates for anything the adapter doesn't pin (e.g. an OpenTable
// export with a custom "Notes" column not in the canonical preset).

import { normaliseHeader } from "./normalise-header";
import { getAdapter } from "./sources";
import type { ImportSource, MappedField } from "./types";

const GENERIC_CANDIDATES: Record<MappedField, readonly string[]> = {
  firstName: ["first name", "firstname", "given name", "forename", "name"],
  lastName: ["last name", "lastname", "surname", "family name"],
  email: ["email", "e-mail", "email address"],
  phone: ["phone", "mobile", "telephone", "phone number", "mobile number"],
  notes: ["notes", "comments", "preferences"],
};

export function suggestMapping(
  headers: ReadonlyArray<string>,
  source?: ImportSource,
): Partial<Record<MappedField, string>> {
  const byNormalised = new Map(headers.map((h) => [normaliseHeader(h), h]));
  const adapter = source ? getAdapter(source) : null;

  const out: Partial<Record<MappedField, string>> = {};
  for (const field of Object.keys(GENERIC_CANDIDATES) as MappedField[]) {
    // Adapter candidates first (more specific), then generic
    // (catches custom columns the operator added).
    const adapterCandidates = adapter?.candidates[field] ?? [];
    const candidates = [...adapterCandidates, ...GENERIC_CANDIDATES[field]];
    for (const candidate of candidates) {
      const found = byNormalised.get(normaliseHeader(candidate));
      if (found) {
        out[field] = found;
        break;
      }
    }
  }
  return out;
}
