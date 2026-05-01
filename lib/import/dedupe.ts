// Within-file dedupe by normalised email.
//
// Two rows in the same upload with the same email collapse into one;
// the LATER row wins, matching the spec's "latest wins for notes"
// rule (`docs/specs/import-export.md`). The earlier occurrence is
// reported as a duplicate so the operator can spot patterns in their
// source export (e.g. ResDiary's tendency to repeat guests across
// venue exports).
//
// This is the file-internal pass. The cross-org pass against existing
// `guests` rows lives in PR3 (the runner) where it can hit the DB.

import type { GuestCandidate } from "./types";

export type DedupeResult = {
  unique: GuestCandidate[];
  duplicates: Array<{
    // Row number of the EARLIER occurrence that got dropped — the
    // later row survives. 1-based, header excluded.
    rowNumber: number;
    email: string;
  }>;
};

// Each candidate carries its original row number so the duplicate
// report can point the operator back at the source CSV. Pure: same
// input → same output, no DB / IO.
export function dedupeWithinFile(
  candidates: ReadonlyArray<{ rowNumber: number; candidate: GuestCandidate }>,
): DedupeResult {
  const seen = new Map<string, { rowNumber: number; candidate: GuestCandidate }>();
  const duplicates: DedupeResult["duplicates"] = [];

  for (const item of candidates) {
    const key = item.candidate.email; // already normalised by validateRow
    const prior = seen.get(key);
    if (prior) {
      // Later wins — record the prior row as the dropped duplicate
      // and overwrite the Map slot. `Map.set` on an existing key
      // updates the VALUE but preserves the original insertion
      // position, which is what we want for "show the import in the
      // order the operator uploaded it" — the surviving slot is
      // wherever the email FIRST appeared.
      duplicates.push({ rowNumber: prior.rowNumber, email: key });
    }
    seen.set(key, item);
  }

  // Map iteration order is insertion order — no sort needed.
  const unique = [...seen.values()].map((item) => item.candidate);

  return { unique, duplicates };
}
