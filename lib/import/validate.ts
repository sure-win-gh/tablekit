// Per-row validation — turns a raw `ParsedRow` + `ColumnMap` into a
// `GuestCandidate` or a `RejectedRow`.
//
// Required fields: firstName + email. Everything else is optional.
// Length caps from `FIELD_MAX_LENGTHS` apply across the board.
// Marketing consent is intentionally not read — the import path
// always lands consent as null per `docs/playbooks/gdpr.md`.

import { isPlausibleEmail, normaliseEmail, normalisePhone } from "./normalize";
import {
  FIELD_MAX_LENGTHS,
  type ColumnMap,
  type GuestCandidate,
  type MappedField,
  type ParsedRow,
  type RejectedRow,
  type ValidationError,
} from "./types";

export type ValidationResult =
  | { ok: true; candidate: GuestCandidate }
  | { ok: false; rejected: RejectedRow };

// Pull a cell value through the column map. Returns trimmed string,
// or `null` when the column wasn't mapped or the cell was blank.
//
// The `field` parameter is `MappedField`, NOT `keyof ColumnMap` —
// that's the compile-time guard that stops a future contributor from
// reading `marketingConsent` here and silently breaking the
// "consent never imports as granted" GDPR rule.
function pickField(row: ParsedRow, columnMap: ColumnMap, field: MappedField): string | null {
  const sourceCol = columnMap[field];
  if (!sourceCol) return null;
  const value = row[sourceCol];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function validateRow(
  row: ParsedRow,
  columnMap: ColumnMap,
  rowNumber: number,
): ValidationResult {
  const errors: ValidationError[] = [];

  const firstNameRaw = pickField(row, columnMap, "firstName");
  const lastNameRaw = pickField(row, columnMap, "lastName");
  const emailRaw = pickField(row, columnMap, "email");
  const phoneRaw = pickField(row, columnMap, "phone");
  const notesRaw = pickField(row, columnMap, "notes");

  if (!firstNameRaw) errors.push({ reason: "missing-required", field: "firstName" });
  if (!emailRaw) errors.push({ reason: "missing-required", field: "email" });

  // Length caps — surface every offender so the operator's rejected-
  // rows report can fix them in one pass.
  if (firstNameRaw && firstNameRaw.length > FIELD_MAX_LENGTHS.firstName) {
    errors.push({ reason: "field-too-long", field: "firstName", max: FIELD_MAX_LENGTHS.firstName });
  }
  if (lastNameRaw && lastNameRaw.length > FIELD_MAX_LENGTHS.lastName) {
    errors.push({ reason: "field-too-long", field: "lastName", max: FIELD_MAX_LENGTHS.lastName });
  }
  if (notesRaw && notesRaw.length > FIELD_MAX_LENGTHS.notes) {
    errors.push({ reason: "field-too-long", field: "notes", max: FIELD_MAX_LENGTHS.notes });
  }
  if (emailRaw && emailRaw.length > FIELD_MAX_LENGTHS.email) {
    errors.push({ reason: "field-too-long", field: "email", max: FIELD_MAX_LENGTHS.email });
  }

  // Phone length is checked post-normalisation so "+44 (0)7700 ..."
  // doesn't fail on whitespace.
  const phone = phoneRaw ? normalisePhone(phoneRaw) : null;
  if (phone && phone.length > FIELD_MAX_LENGTHS.phone) {
    errors.push({ reason: "field-too-long", field: "phone", max: FIELD_MAX_LENGTHS.phone });
  }

  // Email format check runs only when the column was provided (a
  // missing-required error is more useful than a format error on a
  // blank cell). The regex doesn't need to be case-insensitive —
  // `normaliseEmail` lowercases first.
  const emailNormalised = emailRaw ? normaliseEmail(emailRaw) : null;
  if (emailNormalised && !isPlausibleEmail(emailNormalised)) {
    errors.push({ reason: "invalid-email", value: emailNormalised });
  }

  if (errors.length > 0 || !firstNameRaw || !emailNormalised) {
    return { ok: false, rejected: { rowNumber, raw: row, errors } };
  }

  return {
    ok: true,
    candidate: {
      firstName: firstNameRaw,
      lastName: lastNameRaw,
      email: emailNormalised,
      phone,
      notes: notesRaw,
    },
  };
}
