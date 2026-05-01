// Source-format adapter registry + auto-detect.
//
// `detectSource(headers)` walks the adapters in priority order and
// returns the first whose signature-header set is fully present in
// the file. Returns null when nothing matches — the caller falls
// back to the generic-CSV path + the operator's manual choice in
// the upload form.
//
// Priority is most-specific-first: ResDiary's "Customer First Name"
// is more discriminating than anything else; SevenRooms' "VIP
// Status" is more discriminating than OpenTable's "Reservation
// Date" (a SevenRooms export containing both reservation columns
// AND a VIP-Status column would otherwise misroute).

import { normaliseHeader } from "../normalise-header";
import type { ImportSource } from "../types";

import { opentable } from "./opentable";
import { resdiary } from "./resdiary";
import { sevenrooms } from "./sevenrooms";
import type { SourceAdapter } from "./types";

export const ADAPTERS: ReadonlyArray<SourceAdapter> = [resdiary, sevenrooms, opentable];

export function getAdapter(source: ImportSource): SourceAdapter | null {
  if (source === "generic-csv") return null;
  return ADAPTERS.find((a) => a.source === source) ?? null;
}

export function detectSource(headers: ReadonlyArray<string>): SourceAdapter["source"] | null {
  const normalisedFileHeaders = new Set(headers.map(normaliseHeader));
  for (const adapter of ADAPTERS) {
    const allPresent = adapter.signatureHeaders.every((h) =>
      normalisedFileHeaders.has(normaliseHeader(h)),
    );
    if (allPresent) return adapter.source;
  }
  return null;
}

export type { SourceAdapter };
