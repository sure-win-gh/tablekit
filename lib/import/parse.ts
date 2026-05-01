// CSV parsing — thin wrapper around papaparse.
//
// Header-mode only: the first row is the field names, every
// subsequent row is a Record<string, string>. We don't try to coerce
// numbers / booleans here — every field becomes a guest text field
// downstream and the validator handles emptiness / format.
//
// Errors are surfaced as `parseErrors` rather than thrown so the
// caller can decide whether to abort or proceed with partial data.
// This file is server-only by use, but the logic is pure — safe to
// import anywhere.

import Papa from "papaparse";

import type { ParsedRow } from "./types";

export type ParseResult = {
  headers: string[];
  rows: ParsedRow[];
  parseErrors: Array<{ rowNumber: number; message: string }>;
};

// Hard cap to prevent a 1GB malformed CSV from OOM-ing the runner.
// Mirrors the spec's "up to 50k rows" target with headroom.
const MAX_ROWS = 100_000;

export function parseCsv(text: string): ParseResult {
  const result = Papa.parse<ParsedRow>(text, {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (h) => h.trim(),
    // In header mode every cell is a string; the runtime guard would
    // be dead code.
    transform: (v) => v.trim(),
  });

  const headers = (result.meta.fields ?? []).map((h) => h.trim());
  const rows = result.data.slice(0, MAX_ROWS);

  // Papaparse's row index in errors is 0-based and excludes the
  // header — match its convention to avoid an off-by-one when the
  // operator opens the rejected-rows CSV alongside the source file.
  const parseErrors = result.errors.map((e) => ({
    rowNumber: typeof e.row === "number" ? e.row + 1 : 0,
    message: e.message,
  }));

  // Greedy empty-skip means `result.data.length` is post-skip while
  // any pre-skip row numbering is unrecoverable here. Surface the cap
  // without a misleading row number.
  if (result.data.length > MAX_ROWS) {
    parseErrors.push({
      rowNumber: 0,
      message: `File exceeds the ${MAX_ROWS.toLocaleString()}-row import cap; remaining rows ignored.`,
    });
  }

  return { headers, rows, parseErrors };
}
