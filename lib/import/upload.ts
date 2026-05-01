// Upload-side helper for the bulk-import flow. The dashboard action
// (`app/(dashboard)/dashboard/data/import/actions.ts`) wraps this
// with `requireRole('manager')` for auth + audit logging; this
// module is the pure data path so it can be unit-tested without a
// Supabase Auth session.
//
// Persists the encrypted CSV at `status='preview_ready'` so the cron
// (which only picks `status='queued'`) doesn't grab the row before
// the operator confirms the column mapping (PR4b's confirmMapping
// action transitions to 'queued' and triggers the runner).

import "server-only";

import { importJobs } from "@/lib/db/schema";
import { type Plaintext, encryptPii } from "@/lib/security/crypto";
import { adminDb } from "@/lib/server/admin/db";

import type { ImportSource } from "./types";

// 50MB cap matches the DB CHECK on import_jobs.source_size_bytes.
// Counted in bytes (UTF-8) — `String.length` gives UTF-16 code units
// which differs for any multi-byte character.
export const MAX_SIZE_BYTES = 52_428_800;

export type CreateImportJobInput = {
  organisationId: string;
  actorUserId: string;
  source: ImportSource;
  filename: string;
  csvText: string;
};

export type CreateImportJobResult =
  | { ok: true; jobId: string }
  | { ok: false; reason: "empty" | "too-large" };

// Strip directory components a browser might prepend on certain
// platforms, then trim + cap. Filename is plaintext at rest so the
// fewer surprises the better — see gdpr.md §retention "filename".
function sanitiseFilename(input: string): string {
  const lastSlash = Math.max(input.lastIndexOf("/"), input.lastIndexOf("\\"));
  const stripped = lastSlash >= 0 ? input.slice(lastSlash + 1) : input;
  return stripped.trim().slice(0, 200);
}

export async function createImportJob(input: CreateImportJobInput): Promise<CreateImportJobResult> {
  if (input.csvText.length === 0) return { ok: false, reason: "empty" };
  // Byte-length (UTF-8) for the size cap so multi-byte CSVs (e.g.
  // accented names, emoji) can't slip past the char-count check and
  // then blow the DB CHECK on `source_size_bytes`.
  const sizeBytes = Buffer.byteLength(input.csvText, "utf8");
  if (sizeBytes > MAX_SIZE_BYTES) return { ok: false, reason: "too-large" };

  const cipher = await encryptPii(input.organisationId, input.csvText as Plaintext);

  const db = adminDb();
  // Drizzle/pg throws on insert failure (unique violation, FK
  // violation, etc.) so there's no `[]` return path to handle.
  const [row] = await db
    .insert(importJobs)
    .values({
      organisationId: input.organisationId,
      actorUserId: input.actorUserId,
      source: input.source,
      status: "preview_ready",
      filename: sanitiseFilename(input.filename),
      sourceCsvCipher: cipher,
      sourceSizeBytes: sizeBytes,
      // Empty until PR4b's confirmMapping action records the
      // operator's chosen mapping.
      columnMap: {},
    })
    .returning({ id: importJobs.id });
  return { ok: true, jobId: row!.id };
}
