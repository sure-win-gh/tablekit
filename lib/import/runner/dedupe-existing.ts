// Cross-org dedupe — partition candidates against a set of email
// hashes that already exist in the org's `guests` table.
//
// Pure: takes the existing-hashes set as input, doesn't query the
// DB. The runner (PR3b) is responsible for fetching `email_hash`
// values for the org via `hashForLookup(candidate.email, "email")`
// before calling this. Keeping it pure means heavy unit tests + zero
// DB churn, and the writer can pre-compute the hash set in one
// query rather than per-candidate.
//
// Spec rule: "latest wins for notes, unions for tags." We don't yet
// have tags, and notes-merging requires a DB read of the existing
// row. For PR3a this function returns the COLLISION list and lets
// the writer (PR3b) decide whether to UPDATE the existing guest's
// notes or skip — keeps the policy where the DB action lives.

import type { GuestCandidate } from "../types";

export type DedupeAgainstExistingResult = {
  // Candidates with no matching existing guest — safe to INSERT.
  toInsert: GuestCandidate[];
  // Candidates whose email hash matched an existing guest. The
  // writer decides what to do (update notes? skip? upsert?). We
  // surface the email so the rejected-rows report can show the
  // operator which rows were skipped vs imported.
  collisions: Array<{ candidate: GuestCandidate; existingEmailHash: string }>;
};

export function dedupeAgainstExistingHashes(
  candidates: ReadonlyArray<GuestCandidate>,
  // Caller provides a function so hashing happens with the right
  // keying (HMAC under the master key, see lib/security/crypto.ts).
  // Pure within this module: same input → same output for the same
  // hash function.
  hashEmail: (email: string) => string,
  existingEmailHashes: ReadonlySet<string>,
): DedupeAgainstExistingResult {
  const toInsert: GuestCandidate[] = [];
  const collisions: DedupeAgainstExistingResult["collisions"] = [];

  for (const candidate of candidates) {
    const h = hashEmail(candidate.email);
    if (existingEmailHashes.has(h)) {
      collisions.push({ candidate, existingEmailHash: h });
    } else {
      toInsert.push(candidate);
    }
  }

  return { toInsert, collisions };
}
