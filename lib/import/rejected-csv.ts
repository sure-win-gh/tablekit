// Builds an RFC 4180 CSV from the import runner's `pipeline.rejected`
// set so the operator can review what failed.
//
// Output shape:
//   row_number, errors, <original headers in stable union order>
//
// `errors` is a `;`-joined list of structured reasons (the same shape
// the operator UI uses), prefixed by row_number first so a spreadsheet
// scan sorts naturally. The original columns come second so the
// operator can copy-paste corrected values back into their source
// file.

import type { RejectedRow, ValidationError } from "./types";

const CRLF = "\r\n";

export function buildRejectedRowsCsv(rejected: ReadonlyArray<RejectedRow>): string {
  if (rejected.length === 0) return "";

  // Union of headers across all rejected rows — defensive against a
  // future change where validation runs on subset columns. Stable
  // insertion order (first-seen) so a single rejected row's columns
  // appear in the same order as in the source.
  const headerSet = new Set<string>();
  for (const r of rejected) {
    for (const k of Object.keys(r.raw)) headerSet.add(k);
  }
  const headers = ["row_number", "errors", ...headerSet];

  const lines: string[] = [headers.map(escapeCell).join(",")];
  for (const r of rejected) {
    const errorsCell = r.errors.map(formatError).join("; ");
    const row = [String(r.rowNumber), errorsCell, ...[...headerSet].map((h) => r.raw[h] ?? "")];
    lines.push(row.map(escapeCell).join(","));
  }

  // UTF-8 BOM keeps Excel from misinterpreting non-ASCII guest names.
  // Matches the existing toCsv() helper's posture.
  return "﻿" + lines.join(CRLF) + CRLF;
}

// Human-readable but operator-parseable. The reasons match the spec
// of ValidationError so a future automated re-import could split this
// column back into structured form.
function formatError(e: ValidationError): string {
  switch (e.reason) {
    case "missing-required":
      return `missing-required:${e.field}`;
    case "invalid-email":
      return `invalid-email:${e.value}`;
    case "field-too-long":
      return `field-too-long:${e.field}(max=${e.max})`;
  }
}

// RFC 4180 — quote any cell with a comma, quote, CR, or LF; double up
// embedded quotes. Numbers/dates aren't special-cased — every cell is
// a string here.
function escapeCell(s: string): string {
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  // Formula-injection guard — same posture as lib/reports/csv.ts. A
  // leading =, +, -, @ is treated as a formula by Excel/Sheets; prefix
  // a single quote so the cell renders literally.
  if (/^[=+\-@]/.test(s)) return `'${s}`;
  return s;
}
