// Composes the four stages of an import — parse → validate → dedupe
// within file → dedupe against the org's existing guests — into a
// single pure function.
//
// No DB / framework deps. The runner (PR3b) wraps this in a
// transaction, queries existing email hashes, and feeds the result
// into the writer.
//
// Inputs:
//   - csvText: raw upload (already size-checked at the upload action)
//   - columnMap: operator-confirmed mapping
//   - existingEmailHashes: pre-fetched HMAC-SHA256 of every
//     non-erased guest email under the org
//   - hashEmail: same fn the runner uses to compute existingEmailHashes
//
// Outputs:
//   - candidates: ready-to-insert GuestCandidates (post all dedupe)
//   - rejected: rows that failed validation
//   - withinFileDuplicates: same-file collisions (later wins)
//   - existingCollisions: candidates whose email already exists
//   - parseErrors: papaparse-level errors (non-fatal)

import { dedupeWithinFile } from "../dedupe";
import { parseCsv } from "../parse";
import type { ColumnMap, GuestCandidate, RejectedRow } from "../types";
import { validateRow } from "../validate";

import { dedupeAgainstExistingHashes } from "./dedupe-existing";

export type PipelineInput = {
  csvText: string;
  columnMap: ColumnMap;
  existingEmailHashes: ReadonlySet<string>;
  hashEmail: (email: string) => string;
};

export type PipelineResult = {
  candidates: GuestCandidate[];
  rejected: RejectedRow[];
  withinFileDuplicates: Array<{ rowNumber: number; email: string }>;
  existingCollisions: Array<{ candidate: GuestCandidate; existingEmailHash: string }>;
  parseErrors: Array<{ rowNumber: number; message: string }>;
  totalRows: number;
};

export function runPipeline(input: PipelineInput): PipelineResult {
  const parsed = parseCsv(input.csvText);

  // Validate every row, collecting candidates + rejections in one
  // pass. Row numbers are 1-based, header excluded — matches what
  // papaparse uses in its own error indices.
  const candidates: Array<{ rowNumber: number; candidate: GuestCandidate }> = [];
  const rejected: RejectedRow[] = [];
  for (let i = 0; i < parsed.rows.length; i++) {
    const rowNumber = i + 1;
    const result = validateRow(parsed.rows[i]!, input.columnMap, rowNumber);
    if (result.ok) {
      candidates.push({ rowNumber, candidate: result.candidate });
    } else {
      rejected.push(result.rejected);
    }
  }

  const withinFile = dedupeWithinFile(candidates);

  const existing = dedupeAgainstExistingHashes(
    withinFile.unique,
    input.hashEmail,
    input.existingEmailHashes,
  );

  return {
    candidates: existing.toInsert,
    rejected,
    withinFileDuplicates: withinFile.duplicates,
    existingCollisions: existing.collisions,
    parseErrors: parsed.parseErrors,
    totalRows: parsed.rows.length,
  };
}
