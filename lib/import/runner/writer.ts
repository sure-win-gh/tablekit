// Bulk-import writer — runs a single `import_jobs` row through
// the pipeline + persists candidates to `guests`.
//
// Lifecycle: queued/importing → completed | failed
//
// Resumability is delegated to the dedupe pipeline: a re-run
// re-fetches the org's existing email_hash set (which now includes
// rows from the previous partial run) and the
// dedupe-against-existing pass excludes them. So we never INSERT
// a duplicate, even after a crash, without needing ON CONFLICT —
// which is fortunate, because Drizzle 0.45 can't express the
// partial-index predicate (WHERE erased_at IS NULL) anyway.
//
// Marketing consent is forced null on every row regardless of what
// the column-map said — see gdpr.md "consent never imports as
// granted." `imported_from` and `imported_at` are populated for
// provenance.

import "server-only";

import { and, eq, isNull, sql } from "drizzle-orm";

import { guests, importJobs } from "@/lib/db/schema";
import {
  type Ciphertext,
  type Plaintext,
  decryptPii,
  encryptPii,
  hashForLookup,
} from "@/lib/security/crypto";
import { adminDb } from "@/lib/server/admin/db";

import type { ColumnMap, GuestCandidate, ImportSource } from "../types";

import { runPipeline } from "./pipeline";
import { sanitiseImportError } from "./sanitise-error";

// Cap per-INSERT batch so a 50k-row import doesn't ship a single
// monster query. 500 is comfortable for Postgres + the connection
// pool's statement-cache and keeps progress updates frequent.
const INSERT_BATCH = 500;

export type ProcessResult = {
  status: "completed" | "failed";
  imported: number;
  withinFileDuplicates: number;
  existingCollisions: number;
  rejected: number;
  error: string | null;
};

// IMPORTANT: this function uses `adminDb()` and BYPASSES RLS by
// design — it's a cron path with no user session. Do NOT reuse this
// pattern in a request-scoped path; PR4's upload action must verify
// `job.organisationId` against the caller's org BEFORE invoking.
//
// Concurrency model. The atomic claim below transitions
// `status='queued' → 'importing'` via UPDATE … FOR UPDATE SKIP
// LOCKED — only ONE worker can win the claim. A second concurrent
// call sees the row's status as 'importing' (not 'queued'), the
// claim's WHERE filters it out, and the call returns a terminal-
// state no-op. Orphaned 'importing' rows (worker crashed mid-run)
// stay stuck until an operator hits the PR4 retry button, which
// resets `status='queued'` and `error=null` before re-invoking.
//
// Retrying a `failed` job: callers must reset `status='queued'` and
// `error=null` first (PR4's "retry" button does this). The early
// return below treats terminal states as no-ops.
export async function processImportJob(jobId: string): Promise<ProcessResult> {
  const db = adminDb();

  // Atomic claim. UPDATE the row to 'importing' iff it's still
  // queued/importing AND no other worker holds the row lock. The
  // FOR UPDATE SKIP LOCKED in the subselect prevents two pickers
  // running concurrently from both seeing the row.
  type ClaimedRow = {
    id: string;
    organisationId: string;
    source: string;
    sourceCsvCipher: string | null;
    columnMap: unknown;
  };
  const claimed = (await db.execute(sql`
    update import_jobs
    set status = 'importing',
        started_at = coalesce(started_at, now())
    where id in (
      select id from import_jobs
      where id = ${jobId}
        and status = 'queued'
      for update skip locked
    )
    returning id,
              organisation_id as "organisationId",
              source,
              source_csv_cipher as "sourceCsvCipher",
              column_map as "columnMap"
  `)) as unknown as { rows?: ClaimedRow[] } | ClaimedRow[];
  const claimedRows: ClaimedRow[] = Array.isArray(claimed) ? claimed : (claimed.rows ?? []);
  if (claimedRows.length === 0) {
    // Either the job doesn't exist, is in a terminal state, or
    // another worker is holding the lock. Read the row once to
    // decide which message to return — operators looking at logs
    // benefit from accurate counts on no-ops.
    const [existing] = await db.select().from(importJobs).where(eq(importJobs.id, jobId));
    if (!existing) {
      return {
        status: "failed",
        imported: 0,
        withinFileDuplicates: 0,
        existingCollisions: 0,
        rejected: 0,
        error: "job-not-found",
      };
    }
    return {
      status: existing.status === "completed" ? "completed" : "failed",
      imported: existing.rowCountImported,
      rejected: existing.rowCountRejected,
      withinFileDuplicates: 0,
      existingCollisions: 0,
      error: existing.error ?? null,
    };
  }
  const job = claimedRows[0]!;

  try {
    if (!job.sourceCsvCipher) {
      throw new Error("source_csv_cipher is null — cannot resume an import without source bytes.");
    }

    const csvText = await decryptPii(job.organisationId, job.sourceCsvCipher as Ciphertext);

    // Fetch the org's existing non-erased guest email hashes so the
    // pipeline can short-circuit collisions before we hash + encrypt
    // each candidate.
    const existingRows = await db
      .select({ emailHash: guests.emailHash })
      .from(guests)
      .where(and(eq(guests.organisationId, job.organisationId), isNull(guests.erasedAt)));
    const existingEmailHashes = new Set(existingRows.map((r) => r.emailHash));

    const pipeline = runPipeline({
      csvText,
      columnMap: job.columnMap as ColumnMap,
      existingEmailHashes,
      hashEmail: (email: string) => hashForLookup(email, "email"),
    });

    // Hash + encrypt every candidate before insert. Each operation
    // is async (Buffer-backed crypto), so do them in parallel within
    // a batch but serially across batches to keep memory bounded.
    let imported = 0;
    for (let i = 0; i < pipeline.candidates.length; i += INSERT_BATCH) {
      const batch = pipeline.candidates.slice(i, i + INSERT_BATCH);
      const rows = await Promise.all(
        batch.map(async (c) =>
          buildGuestRow(c, job.organisationId, job.id, job.source as ImportSource),
        ),
      );
      // No ON CONFLICT clause: the pipeline's dedupe-against-
      // existing pass already removed candidates whose email_hash
      // matches a non-erased guest in the org, so collisions here
      // would only ever be a race against a concurrent writer.
      // Drizzle 0.45 doesn't support the partial-index predicate
      // (`ON CONFLICT (...) WHERE erased_at IS NULL`) needed to
      // express the constraint, and we'd rather fail-and-retry on
      // the rare race than swallow a real bug. The cron re-runs a
      // failed job; the second pass's existing-hash fetch will
      // include the racer's row and the dedupe will exclude it.
      const inserted = await db.insert(guests).values(rows).returning({ id: guests.id });
      imported += inserted.length;

      // Progress update so the dashboard's counter ticks per batch
      // rather than only on completion.
      await db
        .update(importJobs)
        .set({ rowCountImported: imported })
        .where(eq(importJobs.id, jobId));
    }

    await db
      .update(importJobs)
      .set({
        status: "completed",
        rowCountTotal: pipeline.totalRows,
        rowCountImported: imported,
        rowCountRejected: pipeline.rejected.length,
        completedAt: new Date(),
        // Null the encrypted CSV — retention rule kicks in on
        // success per gdpr.md.
        sourceCsvCipher: null,
        sourceSizeBytes: null,
      })
      .where(eq(importJobs.id, jobId));

    return {
      status: "completed",
      imported,
      withinFileDuplicates: pipeline.withinFileDuplicates.length,
      existingCollisions: pipeline.existingCollisions.length,
      rejected: pipeline.rejected.length,
      error: null,
    };
  } catch (err) {
    const message = sanitiseImportError(err);
    await db
      .update(importJobs)
      .set({ status: "failed", error: message })
      .where(eq(importJobs.id, jobId));
    return {
      status: "failed",
      imported: 0,
      withinFileDuplicates: 0,
      existingCollisions: 0,
      rejected: 0,
      error: message,
    };
  }
}

async function buildGuestRow(
  candidate: GuestCandidate,
  organisationId: string,
  importJobId: string,
  source: ImportSource,
): Promise<typeof guests.$inferInsert> {
  // hashForLookup is sync; encryptPii is async (per-org DEK fetch).
  // Run the encrypts in parallel within the candidate.
  const [emailCipher, lastNameCipher, phoneCipher] = await Promise.all([
    encryptPii(organisationId, candidate.email as Plaintext),
    encryptPii(organisationId, (candidate.lastName ?? "") as Plaintext),
    candidate.phone
      ? encryptPii(organisationId, candidate.phone as Plaintext)
      : Promise.resolve(null),
  ]);
  return {
    organisationId,
    firstName: candidate.firstName,
    lastNameCipher,
    emailCipher,
    emailHash: hashForLookup(candidate.email, "email"),
    phoneCipher: phoneCipher,
    importedFrom: source,
    importedAt: new Date(),
    importJobId,
    // Marketing consent must NEVER carry over from the source —
    // the legal basis didn't transfer (gdpr.md). We persist NULL
    // explicitly rather than relying on column defaults so a future
    // schema change adding a non-null default can't silently grant
    // consent on bulk import.
    marketingConsentAt: null,
    marketingConsentEmailAt: null,
    marketingConsentSmsAt: null,
  };
}

// Cron entry point. Finds the next queued job and hands it to
// `processImportJob`, which does its own atomic claim. The picker
// here intentionally only looks at `status='queued'` — orphaned
// `importing` jobs (worker crashed mid-run) need an operator-driven
// reset to 'queued' before the cron will pick them up again. PR4
// surfaces a "retry" button for that.
//
// Caller (the route handler) is responsible for the bearer-auth check.
export async function processNextImportJob(): Promise<{
  jobId: string | null;
  result: ProcessResult | null;
}> {
  const db = adminDb();
  const [next] = await db
    .select({ id: importJobs.id })
    .from(importJobs)
    .where(eq(importJobs.status, "queued"))
    .orderBy(importJobs.createdAt)
    .limit(1);
  if (!next) return { jobId: null, result: null };
  const result = await processImportJob(next.id);
  return { jobId: next.id, result };
}

// Used by integration tests to drive a job by id without going
// through the cron path. Re-exports `processImportJob` for clarity.
export { processImportJob as runImportJobForTest };
