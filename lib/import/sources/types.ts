// Source-format adapter shape. One adapter per supported export
// format (OpenTable / ResDiary / SevenRooms). Adapters do TWO
// things: they help us auto-detect which source a CSV came from,
// and they tell the mapping wizard which field corresponds to
// which header for that source.
//
// Header matching is case-insensitive + punctuation-stripped — the
// same normalisation `suggest-mapping.ts` uses. So an adapter can
// list "First Name" as the canonical name and a file with the
// header "first_name" still resolves.

import type { ImportSource, MappedField } from "../types";

export type SourceAdapter = {
  source: Exclude<ImportSource, "generic-csv">;
  // Distinctive header substrings. Auto-detect uses an ALL-of
  // semantics — every signature header must appear in the file's
  // header set (after normalisation) for the adapter to claim the
  // file. Picks the first source whose signature matches.
  signatureHeaders: ReadonlyArray<string>;
  // Per-field candidate header names in priority order. The first
  // one matched against the file's actual headers wins. Lets us
  // express "ResDiary calls it 'Customer First Name', OpenTable
  // calls it 'First Name'."
  candidates: Partial<Record<MappedField, ReadonlyArray<string>>>;
};
