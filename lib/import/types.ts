// Shared types for the bulk-import pipeline.
//
// Lives in lib/import/ so the parser, validator, dedupe helper, and
// (later) the runner all share one definition. No DB / framework
// imports here — these types describe the shape of data flowing
// through the pure-function pipeline before it reaches `adminDb()`.

// Fields that map from a CSV column INTO a `GuestCandidate`. Kept
// distinct from `ColumnMap` below so `pickField` can be typed to
// `MappedField` and the compiler refuses to read `marketingConsent`
// — that mapping is allowed for display in the operator's preview
// but the value is never plumbed through. See gdpr.md.
export type MappedField = "firstName" | "lastName" | "email" | "phone" | "notes";

// Operator-confirmed mapping from CSV header → guest field. The form
// in PR4 lets the operator override the auto-detected mapping; the
// runner reads this object off `import_jobs.column_map`.
//
// Values are strings (the CSV header text). The `marketingConsent`
// branch is intentionally OUTSIDE `MappedField` so it cannot be read
// by `pickField`. The operator may map it (so the preview can show
// the column was acknowledged) but the value is dropped — every
// imported guest lands with consent flags null. See gdpr.md.
export type ColumnMap = Partial<Record<MappedField, string>> & {
  marketingConsent?: string;
};

// One candidate row, post-validation, ready for the runner to encrypt
// + persist. All fields normalised; no plaintext PII landed yet but
// these are about to be hashed (email/phone) and encrypted in PR3.
export type GuestCandidate = {
  firstName: string;
  lastName: string | null;
  email: string; // lowercased + trimmed
  phone: string | null; // digits-only
  notes: string | null;
};

// Untyped CSV row — header → cell. Cells are strings; papaparse
// returns `string` from header-mode parsing.
export type ParsedRow = Record<string, string>;

export type ValidationError =
  | { reason: "missing-required"; field: keyof GuestCandidate }
  | { reason: "invalid-email"; value: string }
  | { reason: "field-too-long"; field: keyof GuestCandidate; max: number };

// One row that didn't make the cut. Flushed to the rejected-rows CSV
// at the end of the import for operator review.
export type RejectedRow = {
  rowNumber: number; // 1-based, excluding the header row
  raw: ParsedRow;
  errors: ValidationError[];
};

// Source-format identifier — mirrors `import_jobs.source` and the DB
// CHECK on `guests.imported_from`.
export type ImportSource = "opentable" | "resdiary" | "sevenrooms" | "generic-csv";

// Field length caps. Mirror what the dashboard form would enforce on
// a manual create; the import path is held to the same standard.
export const FIELD_MAX_LENGTHS = {
  firstName: 100,
  lastName: 100,
  email: 254, // RFC 5321
  phone: 32,
  notes: 1000,
} as const satisfies Record<keyof GuestCandidate, number>;
