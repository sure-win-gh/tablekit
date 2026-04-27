# Phase: `import-export` — switching cost remover

Plan for [docs/specs/import-export.md](../../docs/specs/import-export.md). Dependencies: [guests.md](../../docs/specs/guests.md), [bookings.md](../../docs/specs/bookings.md), [gdpr.md](../../docs/playbooks/gdpr.md), [security.md](../../docs/playbooks/security.md), [payments.md](../../docs/playbooks/payments.md).

## Goal

Two halves: **Export** (every tier, MVP — operators can pull bookings/guests/messages/payments + full zip backup with signed 24h URL) and **Import** (Plus tier — CSV upload from OpenTable/ResDiary/SevenRooms/generic with column mapping, dedupe, resumable background job).

## Why a four-PR split (mandatory)

Single-PR diff lands ~1500 LOC across ~25 files, four migrations, two new sub-processor surfaces (Supabase Storage bucket — *not* a new sub-processor, see flag below — and a CSV-parsing dep), and two new background-job patterns. That breaks rule #7 (over 3 files → /plan) and the security baseline of "small reversible commits". Split below.

| PR | Title | Scope | LOC est. |
|----|-------|-------|----------|
| 1 | `feat(export): inline CSV+JSON for bookings & guests` | Settings → Data page; streaming server-action downloads for the two largest entities. No new tables, no Storage, no zip. | ~250 |
| 2 | `feat(export): full backup zip + payments + messages + email link` | `export_jobs` table, Supabase Storage bucket `org-exports`, fflate zip, Resend email when ready, cron drain. | ~450 |
| 3 | `feat(import): schema + parsers (no UI)` | `imported_from`/`imported_at` cols, `import_jobs` table, format detection + per-source parsers, pure unit-tested. Adds `csv-parse` (pinned). | ~350 |
| 4 | `feat(import): upload UI, column mapping wizard, worker, dedupe` | Plus-tier gated dashboard flow, ClamAV via Supabase Storage scan, resumable worker, rejected-row report. | ~500 |

PRs 3 and 4 may merge to a feature branch and ship together once the parser + UI are both green; but they review separately.

## Pre-flight flags (per skill rules)

> **PCI scope:** No expansion. Payments export columns are `stripe_intent_id`, `kind`, `amount_minor`, `currency`, `status`, `failure_*`, timestamps. Zero card data. Stays SAQ-A.
>
> **Sub-processors:** No new vendor. We use **Supabase Storage** (Supabase is already on the sub-processor list — Storage is part of the existing relationship). Resend already in scope. No new entries to `/legal/sub-processors`.
>
> **Plaintext PII outside `lib/security/crypto.ts`:** This is the inherent risk of an export feature. Plan honours the rule by routing every decrypt through `decryptPii(orgId, …)` per-cell at the writer boundary; the CSV/JSON writer is a downstream consumer like a dashboard render. **No new module decrypts directly.** No plaintext is written to the worker's local disk in PR2/PR4 — chunks are decrypted into memory, streamed into the in-memory zip (fflate) and uploaded straight to Storage via `Buffer`/`Readable`. Spec (criterion 3 of Export AC) explicitly authorises decryption-in-export for the owning org. Flag noted; proceeding.

## Architectural decisions (locked)

| # | Decision |
|---|---|
| IE1 | Export storage: private Supabase bucket `org-exports`, RLS-locked to `service_role`. Reads from dashboard hand back a Supabase **signed URL**, single-use, 24h TTL (matches Export AC). |
| IE2 | Inline downloads (PR1): bookings + guests stream straight from a Server Action via `Response` body — no Storage hop for the two most common ad-hoc exports. Bypasses the 24h signed-URL machinery; the audit trail is identical. |
| IE3 | Background-job pattern: persisted-state row in `export_jobs` / `import_jobs`, status enum (`queued|running|succeeded|failed`), worker drains via cron + inline kick-off on user action. Mirrors `messages` worker pattern — no Redis, no Supabase Edge Function. |
| IE4 | Cron entry: extend the existing `app/api/cron/deposit-janitor/route.ts` rather than add a new path (Vercel Hobby plan caps total cron paths). Renames in PR5+ if scope grows; for now, "deposit-janitor" is a misnomer that's already covering messaging — `data-jobs` rename is deferred. |
| IE5 | CSV writer (export): hand-rolled RFC 4180 stringifier in `lib/io/csv.ts` (~40 LOC, no dep). Quoting + escaping covered by unit tests. JSON: native `JSON.stringify`, NDJSON for the messages stream (could be large). |
| IE6 | CSV reader (import): `csv-parse@5.6.0` (pinned, MIT, 0 runtime deps). Hand-rolling the parser is brittle (RFC 4180 + quoted newlines + BOM). Adds **one** direct dependency, justified per security playbook. |
| IE7 | Zip: `fflate@0.8.2` (pinned, MIT, ~8KB). Streaming zip-writer — needed for the full-backup deliverable. `archiver` rejected (heavy + Node-only). |
| IE8 | Format detection: header-signature match against known fixed column lists per source. Generic CSV falls through to the manual mapping wizard. Detection logic is pure and unit-tested. |
| IE9 | Dedupe key: `(organisationId, emailHash)`. We already have the partial unique index on guests; import is a true upsert. Conflict resolution: notes union (newline-joined dedupe), tags union, `last_visit_at` = max, encrypted PII never overwritten with empty. |
| IE10 | Marketing consent on import: always null. Hard-coded. **Not** controlled by an operator toggle — the legal basis didn't transfer (gdpr.md §Lawful basis). Operator has to re-collect consent. |
| IE11 | File size cap on import: 5MB (per `security.md` §Input validation). Larger files rejected at upload boundary with a clear message. 50k rows of typical guest CSV fits. |
| IE12 | Antivirus: rely on Supabase Storage's bucket scan (already on by default for the project). If the file is quarantined, the upload event won't surface, and the job stays queued past its grace period → marked failed. |
| IE13 | Plan gating: Import requires `organisations.plan === 'plus'`. Export available on every tier. Server-action checks plan before queuing an import job; UI hides upload behind an upsell on free/core. |
| IE14 | Resumability: import worker processes in 1k-row chunks; `import_jobs.cursor` + `processed_count` advance atomically. Crash mid-chunk replays the chunk; idempotent because every row is an upsert keyed on `(org_id, email_hash)`. |
| IE15 | Rejected rows: collected during the run, written as `errors-<jobId>.csv` to the same `org-exports` bucket (under `imports/errors/`), linked from the import-job detail page. Headers: `row_number,reason,raw_line`. |
| IE16 | Provenance: new columns on `guests` — `imported_from text NULL`, `imported_at timestamptz NULL`. NULL on host-created and widget-created guests. Read-only from the dashboard. |
| IE17 | Decryption-in-export contract: writer code calls `decryptPii(orgId, cipher)` directly — no helper, no batch decryptor. Keeps the surface tiny and reviewable. The cost is per-row decrypts; acceptable for ≤ 50k rows. |
| IE18 | Routes/UI: Settings → Data lives at `/dashboard/data` (new top-level dashboard section, not nested under organisation, because export covers all venues for the org and import is org-level too). |

## Non-goals

- Live API imports (terms forbid, files are good enough — spec confirms).
- Resy / Quandoo support at launch (parser slot is left open via the generic mapping wizard).
- Per-venue export filtering — first cut is org-wide. Filter UI lands later.
- Encrypted export downloads (PGP / age) — out of scope; Supabase signed URL + TLS is the boundary.
- Erased-guest export inclusion — `erased_at IS NOT NULL` rows are excluded from export (no PII to decrypt).
- Re-encrypting export at rest with a per-export key. Bucket TDE at rest is sufficient; URL is the only access path; 24h TTL caps blast radius.

---

## PR 1 — `feat(export): inline CSV+JSON for bookings & guests`

### Files to create

```
app/(dashboard)/dashboard/data/page.tsx
app/(dashboard)/dashboard/data/forms.tsx
app/(dashboard)/dashboard/data/actions.ts
lib/io/csv.ts
lib/export/guests.ts
lib/export/bookings.ts
tests/unit/lib/io/csv.test.ts
tests/unit/lib/export/guests.test.ts
tests/unit/lib/export/bookings.test.ts
tests/integration/export-actions.test.ts
```

### Files to modify

- [lib/server/admin/audit.ts](../../lib/server/admin/audit.ts) — add `"data.exported"` to `AuditAction`, `"export"` to `AuditTargetType`.
- [app/(dashboard)/dashboard/page.tsx](../../app/(dashboard)/dashboard/page.tsx) — add a "Data" nav entry (host-and-up readable; data export itself requires manager).

### Migrations

None.

### RLS policies

None (no new tables).

### Decryption boundary

`lib/export/guests.ts` and `lib/export/bookings.ts` import `decryptPii` and `decryptCipher` from `@/lib/security/crypto`. Each row decrypts its own ciphers in a loop; output rows go straight to the streaming response writer. **No new module reads `wrappedDek`**.

### Tests

- Unit: CSV stringifier — quoted commas, embedded newlines, embedded quotes, leading `=` (formula injection guard prefixes with `'`), unicode.
- Unit: guests export — golden-file comparison for a 3-row fixture (encrypted on the way in, decrypted in the output).
- Unit: bookings export — same shape, with denormalised guest name + venue name + service name columns.
- Integration: server action returns 200 with the right `Content-Type` + `Content-Disposition`; non-manager rejected with 403; cross-tenant request can't pull another org's rows; `audit_log` row written.

### Risks

- **Formula injection in spreadsheet readers** — Excel/Sheets execute cells starting `=`, `+`, `-`, `@`. Mitigation: CSV writer prefixes `'` to any cell beginning with those. Unit test enforces.
- **Memory blow-up on large orgs** — 50k bookings, ~200 bytes each ≈ 10 MB; safe in-memory, but if we ever exceed 100k we want a streamed Drizzle cursor. Today's caps make this a non-issue; called out for future review.
- **Decryption N+1** — 50k decrypts × ~100µs ≈ 5s. Acceptable for a server action, but add a comment so a future refactor doesn't try to batch through a side channel.

### Rollback

Single PR, no migrations, no Storage objects. Revert the merge commit. No data state to undo.

### Estimated diff size

~250 LOC, 12 files (10 new + 2 modified).

---

## PR 2 — `feat(export): full backup zip + payments + messages + email link`

### Files to create

```
app/(dashboard)/dashboard/data/jobs/[jobId]/page.tsx
lib/export/payments.ts
lib/export/messages.ts
lib/export/full-backup.ts
lib/export/job.ts
lib/email/templates/export-ready.tsx
lib/email/senders/export-ready.ts
drizzle/migrations/0017_<random>.sql
drizzle/migrations/meta/0017_snapshot.json
tests/unit/lib/export/payments.test.ts
tests/unit/lib/export/messages.test.ts
tests/unit/lib/export/full-backup.test.ts
tests/integration/export-job.test.ts
```

### Files to modify

- [lib/db/schema.ts](../../lib/db/schema.ts) — add `exportJobs` table.
- [lib/server/admin/audit.ts](../../lib/server/admin/audit.ts) — add `"data.export.queued" | "data.export.completed" | "data.export.failed"`, `AuditTargetType` adds `"export_job"`.
- [app/(dashboard)/dashboard/data/actions.ts](../../app/(dashboard)/dashboard/data/actions.ts) (PR1) — add `requestFullBackup()` server action.
- [app/(dashboard)/dashboard/data/page.tsx](../../app/(dashboard)/dashboard/data/page.tsx) (PR1) — surface job-list table + "Generate full backup" button.
- [app/api/cron/deposit-janitor/route.ts](../../app/api/cron/deposit-janitor/route.ts) — call `processNextExportJob({limit: 5})` after the existing sweepers.
- `package.json` — add `fflate@0.8.2`, pinned (no `^`).
- [docs/playbooks/security.md](../../docs/playbooks/security.md) — add an entry under "File uploads / downloads" documenting the export bucket + URL TTL.

### Migrations

`drizzle/migrations/0017_<random>.sql` — **forward-only, additive only**. Per the migration reminder: drop in two releases, never one. Nothing in this migration drops or alters existing structure.

```sql
-- 0017: export_jobs — async full-org backup queue
CREATE TABLE "export_jobs" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organisation_id" uuid NOT NULL,
  "requested_by_user_id" uuid,
  "status"          text NOT NULL DEFAULT 'queued',
  "kind"            text NOT NULL DEFAULT 'full_backup',
  "storage_path"    text,
  "size_bytes"      bigint,
  "row_counts"      jsonb NOT NULL DEFAULT '{}'::jsonb,
  "error"           text,
  "started_at"      timestamptz,
  "completed_at"    timestamptz,
  "expires_at"      timestamptz NOT NULL,
  "created_at"      timestamptz NOT NULL DEFAULT now(),
  "updated_at"      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE "export_jobs"
  ADD CONSTRAINT "export_jobs_org_fk"
  FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade;
ALTER TABLE "export_jobs"
  ADD CONSTRAINT "export_jobs_actor_fk"
  FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null;
ALTER TABLE "export_jobs"
  ADD CONSTRAINT "export_jobs_status_check"
  CHECK (status IN ('queued','running','succeeded','failed'));
ALTER TABLE "export_jobs"
  ADD CONSTRAINT "export_jobs_kind_check"
  CHECK (kind IN ('full_backup'));
CREATE INDEX "export_jobs_org_idx" ON "export_jobs" ("organisation_id");
CREATE INDEX "export_jobs_org_created_idx" ON "export_jobs" ("organisation_id", "created_at" DESC);
CREATE INDEX "export_jobs_worker_idx" ON "export_jobs" ("created_at")
  WHERE status IN ('queued','running');

-- updated_at touch
CREATE OR REPLACE FUNCTION public.touch_export_jobs_updated_at()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;
CREATE TRIGGER touch_export_jobs_updated_at
  BEFORE UPDATE ON public.export_jobs
  FOR EACH ROW EXECUTE FUNCTION public.touch_export_jobs_updated_at();

-- RLS: same shape as dsar_requests (read-only for members; writes via adminDb)
ALTER TABLE "export_jobs" ENABLE ROW LEVEL SECURITY;
```

### RLS policies

```sql
CREATE POLICY "export_jobs_member_read" ON "export_jobs"
  FOR SELECT TO authenticated
  USING (organisation_id IN (SELECT public.user_organisation_ids()));
```

No INSERT/UPDATE/DELETE policy for `authenticated` — writes flow through `adminDb()` after a manual org-scope check inside the action. Matches the `messages` / `payments` / `dsar_requests` pattern (security.md §Cross-tenant bugs).

### Storage bucket

Create the bucket out-of-band (Supabase dashboard or migration script in `scripts/`):

- Bucket name: `org-exports`
- Public: **No**
- File size limit: 500 MB (covers a maximal full-backup zip; messages NDJSON is the long tail)
- Allowed MIME types: `application/zip`, `text/csv`, `application/x-ndjson`, `application/json`
- RLS on `storage.objects`: only `service_role` reads/writes; signed URLs handed to operators

Storage layout: `org-exports/{org_id}/full-backup/{job_id}.zip` and `org-exports/{org_id}/imports/errors/{job_id}.csv` (PR4 reuses).

### Decryption boundary

`lib/export/full-backup.ts` orchestrates per-entity writers and pipes the zip to Storage. Each writer (`guests.ts`, `bookings.ts`, `payments.ts`, `messages.ts`) decrypts in-row through `decryptPii`. The zip writer (fflate `Zip`) accepts `Uint8Array` chunks; we never write plaintext to the worker's local disk.

### Tests

- Unit: payments export — Stripe-ID columns, no PII, refund rows with negative amounts.
- Unit: messages export — NDJSON, decrypted body, plaintext channel/template/status.
- Unit: full-backup — one fixture org with 5 guests, 5 bookings, 3 payments, 4 messages → zip contents present, schema-doc README included, byte-stable hash.
- Integration: queue an export, run `processNextExportJob`, assert `status='succeeded'`, signed URL resolves, `audit_log` has `data.export.queued` + `data.export.completed`.
- Integration: cross-tenant — org A user can't see org B's export-job rows or download org B's signed URL.
- Integration: signed URL expires after 24h (mock clock).

### Risks

- **Storage egress cost surprise** — a venue running monthly backups on a 50k-row org with 6 months of messages produces ~30MB zips × N. Acceptable on Supabase Pro, called out for billing review.
- **Cron throughput** — Hobby plan caps cron at once/day. Inline-kick-off in `requestFullBackup()` runs the worker immediately as well; cron is only the backstop. Same model as messaging dispatch.
- **fflate streaming back-pressure** — fflate is sync; for very large messages we buffer the chunk before the next write. Cap on messages export = 100k rows; > that and we paginate (called out for a later phase).
- **Email delivery race** — operator might refresh the page before the email arrives. UI polls the job row on the data page and reveals the download link as soon as `status='succeeded'`.
- **Audit retention vs export retention** — `audit_log` keeps the export action 2y (gdpr.md), the file itself expires at 24h. `export_jobs.expires_at` is the contract.

### Rollback

PR2 is reversible by:

1. Revert the merge commit.
2. Forward-only follow-up migration **next release** (per the two-release rule): `DROP TABLE export_jobs CASCADE;` then drop the bucket. Leaving the table in place between revert and cleanup is harmless — nothing reads it after the revert.
3. Storage bucket: `supabase storage rm --recursive org-exports` once cleanup migration ships.

### Estimated diff size

~450 LOC, 13 files (10 new + 3 modified, plus migration + snapshot).

---

## PR 3 — `feat(import): schema + parsers (no UI)`

### Files to create

```
lib/import/types.ts
lib/import/detect.ts
lib/import/parsers/opentable.ts
lib/import/parsers/resdiary.ts
lib/import/parsers/sevenrooms.ts
lib/import/parsers/generic.ts
lib/import/normalise.ts
drizzle/migrations/0018_<random>.sql
drizzle/migrations/meta/0018_snapshot.json
tests/unit/lib/import/detect.test.ts
tests/unit/lib/import/parsers/opentable.test.ts
tests/unit/lib/import/parsers/resdiary.test.ts
tests/unit/lib/import/parsers/sevenrooms.test.ts
tests/unit/lib/import/parsers/generic.test.ts
tests/fixtures/import/opentable-50.csv
tests/fixtures/import/resdiary-50.csv
tests/fixtures/import/sevenrooms-50.csv
```

### Files to modify

- [lib/db/schema.ts](../../lib/db/schema.ts) — add `importedFrom`, `importedAt` columns to `guests`; add `importJobs` table.
- `package.json` — add `csv-parse@5.6.0`, pinned. Justification comment: only sane RFC 4180 parser.

### Migrations

`drizzle/migrations/0018_<random>.sql` — **forward-only, additive only**.

```sql
-- 0018: import_jobs + guest provenance
ALTER TABLE "guests" ADD COLUMN "imported_from" text NULL;
ALTER TABLE "guests" ADD COLUMN "imported_at" timestamptz NULL;

CREATE TABLE "import_jobs" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organisation_id" uuid NOT NULL,
  "requested_by_user_id" uuid,
  "status"          text NOT NULL DEFAULT 'queued',
  "source"          text NOT NULL,            -- 'opentable'|'resdiary'|'sevenrooms'|'generic'
  "upload_path"     text NOT NULL,            -- org-exports/{org_id}/imports/source/{job_id}.csv
  "mapping"         jsonb NOT NULL DEFAULT '{}'::jsonb,
  "total_rows"      integer,
  "processed_count" integer NOT NULL DEFAULT 0,
  "inserted_count"  integer NOT NULL DEFAULT 0,
  "updated_count"   integer NOT NULL DEFAULT 0,
  "rejected_count"  integer NOT NULL DEFAULT 0,
  "cursor"          integer NOT NULL DEFAULT 0,
  "error_report_path" text,
  "error"           text,
  "started_at"      timestamptz,
  "completed_at"    timestamptz,
  "created_at"      timestamptz NOT NULL DEFAULT now(),
  "updated_at"      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE "import_jobs"
  ADD CONSTRAINT "import_jobs_org_fk"
  FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade;
ALTER TABLE "import_jobs"
  ADD CONSTRAINT "import_jobs_actor_fk"
  FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null;
ALTER TABLE "import_jobs"
  ADD CONSTRAINT "import_jobs_status_check"
  CHECK (status IN ('queued','running','succeeded','failed'));
ALTER TABLE "import_jobs"
  ADD CONSTRAINT "import_jobs_source_check"
  CHECK (source IN ('opentable','resdiary','sevenrooms','generic'));
CREATE INDEX "import_jobs_org_idx" ON "import_jobs" ("organisation_id");
CREATE INDEX "import_jobs_org_created_idx" ON "import_jobs" ("organisation_id", "created_at" DESC);
CREATE INDEX "import_jobs_worker_idx" ON "import_jobs" ("created_at")
  WHERE status IN ('queued','running');

CREATE OR REPLACE FUNCTION public.touch_import_jobs_updated_at()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;
CREATE TRIGGER touch_import_jobs_updated_at
  BEFORE UPDATE ON public.import_jobs
  FOR EACH ROW EXECUTE FUNCTION public.touch_import_jobs_updated_at();

ALTER TABLE "import_jobs" ENABLE ROW LEVEL SECURITY;
```

The two `guests` columns are nullable with no default — pure additive change. Existing rows stay null (provenance: host-created).

### RLS policies

```sql
CREATE POLICY "import_jobs_member_read" ON "import_jobs"
  FOR SELECT TO authenticated
  USING (organisation_id IN (SELECT public.user_organisation_ids()));
```

(No INSERT/UPDATE/DELETE for `authenticated` — writes via `adminDb()` after server-action plan + role checks.)

### Decryption boundary

PR3 is parsing only. Parsers consume CSV → emit normalised plaintext rows in memory; no encryption, no DB writes. The PR4 worker is what will call `encryptPii` on the way to `guests`.

### Tests

- Unit: `detect.ts` — recognises each source by its known header set; falls back to `generic`.
- Unit per parser: 50-row golden fixture decoded into a normalised `ImportedGuest[]`. Fixtures sourced from publicly-documented competitor CSV samples (no real guest data).
- Unit: `normalise.ts` — phone normalisation (UK +44 / 07 / 0044), email lowercasing, name trimming, multi-tag splitting, blank-row skipping, marketing-consent always null even if column present.
- Unit: rejected-row policy — missing email AND missing phone → rejected; malformed email → rejected with reason; everything else accepted.

### Risks

- **CSV ambiguity** — competitors change their export format unannounced. Mitigation: format detection is permissive (header order doesn't matter, extra columns ignored, generic fallback covers anything we miss). We surface "detected format" in PR4's preview so the operator can override.
- **Excel-mangled dates / phones** — Excel converts phone numbers with leading 0 to numeric. Mitigation: normaliser treats all phone fields as strings; if the input is a number we still emit a UK-formatted string and warn in the rejected-row report when format doesn't match `^\+?[0-9]{6,15}$`.
- **`csv-parse` version drift** — pinned to `5.6.0`. Dependabot patch updates manually reviewed.

### Rollback

Schema additions are additive. Revert + cleanup migration next release: `DROP TABLE import_jobs CASCADE; ALTER TABLE guests DROP COLUMN imported_from, DROP COLUMN imported_at;`. Two-release pattern preserved.

### Estimated diff size

~350 LOC + 3 fixture files (~5KB each), 18 files.

---

## PR 4 — `feat(import): upload UI, column mapping wizard, worker, dedupe`

### Files to create

```
app/(dashboard)/dashboard/data/import/page.tsx
app/(dashboard)/dashboard/data/import/forms.tsx
app/(dashboard)/dashboard/data/import/actions.ts
app/(dashboard)/dashboard/data/import/[jobId]/page.tsx
app/(dashboard)/dashboard/data/import/[jobId]/forms.tsx
lib/import/job.ts
lib/import/upsert-guest.ts
lib/storage/server.ts
tests/unit/lib/import/upsert-guest.test.ts
tests/integration/import-job.test.ts
tests/integration/import-rls.test.ts
tests/e2e/import-flow.spec.ts
```

### Files to modify

- [lib/server/admin/audit.ts](../../lib/server/admin/audit.ts) — `"data.import.queued" | "data.import.succeeded" | "data.import.failed"`, `AuditTargetType` adds `"import_job"`.
- [app/(dashboard)/dashboard/data/page.tsx](../../app/(dashboard)/dashboard/data/page.tsx) — link to "Import from another platform" (Plus only; otherwise upsell).
- [app/api/cron/deposit-janitor/route.ts](../../app/api/cron/deposit-janitor/route.ts) — call `processNextImportJob({limit: 3})` after exports.

### Migrations

None (the schema landed in PR3).

### Decryption boundary

`lib/import/upsert-guest.ts` calls `encryptPii(orgId, value)` for every PII cell and `hashForLookup(value, "email"|"phone")` for the dedupe keys. **No new module reads `wrappedDek`.** Conflict resolution upserts via Drizzle on `(organisation_id, email_hash)` partial unique index — atomic, no SELECT-then-UPDATE race. Notes are unioned by reading the existing `notes_cipher`, decrypting, joining with newline, re-encrypting — explicit per-conflict path, called out in code review.

### Storage layout

- Uploads: `org-exports/{org_id}/imports/source/{job_id}.csv`
- Error reports: `org-exports/{org_id}/imports/errors/{job_id}.csv`

Both expire 30 days post-completion (cron sweep, deferred phase).

### Worker contract

```
processNextImportJob({ limit }):
  for each queued/running row up to `limit`:
    transition queued → running (CAS on status)
    fetch CSV from Storage (signed URL, internal)
    parse via lib/import/parsers/<source> with mapping
    for chunks of 1000 rows:
      for each row:
        normalise; if reject → push to error report, continue
        upsert via lib/import/upsert-guest.ts
        increment counters
      commit cursor & counters in one UPDATE
    on completion: write error CSV, status → succeeded, audit
    on error: status → failed, error column populated, audit
```

### RLS

`import_jobs` policy already applied in PR3. No additions.

### Tests

- Unit: `upsert-guest.ts` — new email = INSERT; matching email_hash = UPDATE with notes-union, tags-union (deferred to a `guests.tags` column when guests-tags ships; PR4 stores tags only if the column exists), no overwrite of non-null PII with null. Email_hash + phone_hash collision-only path validated.
- Integration: queue an import for a 1k-row OpenTable fixture, run worker to completion, assert insert+update counts, error-report CSV present, `imported_from='opentable'` set on every new row.
- Integration: kill the worker mid-chunk, restart, assert counts converge correctly (no double-insert, idempotent).
- Integration: cross-tenant — org A's import never writes a guest row with org B's `organisation_id`; org B can't read org A's `import_jobs` rows; org B can't fetch a signed download URL for org A's error report.
- Integration: marketing consent always null — even if the source CSV has an opted-in column.
- Integration: free/core plan can't queue an import (server action returns 402).
- E2E: upload a 100-row OpenTable CSV, walk through the column-mapping wizard, see the 10-row preview, click Import, watch the job complete, see imported guests in `/dashboard/guests`.

### Risks

- **Plaintext PII in transit on the worker** — already covered by IE17 / decrypt-boundary note. Reviewer to verify: zero `console.log`, zero `JSON.stringify(row)` in the import code path. `code-reviewer` subagent will flag — and the security review subagent should be run.
- **Mapping wizard XSS** — operator-supplied column names rendered in JSX. React escaping handles it; no `dangerouslySetInnerHTML`.
- **CSV quoted-newline DoS** — `csv-parse` has documented memory bounds; we additionally cap rows-per-job at 50k upfront (file-size cap of 5MB makes this academic).
- **Antivirus latency** — Supabase Storage scan is async. Worker first-poll might see a quarantined file; treat 404 from the signed-fetch as `failed` with a clear message.
- **Existing-guest stomp** — operator imports a list that contains the same email as an existing host-created guest. Conflict-merge rules above keep the first_name from the existing row (host-typed beats import); update only sets `imported_from` / `imported_at` if previously null. Test enforces.
- **Group-CRM interplay** — when `org.groupCrmEnabled` is on, dedupe is still org-scoped (we don't merge across orgs). Out-of-scope: cross-org dedupe.
- **Plus-tier gate bypass** — the upload server action checks `org.plan` server-side; UI is just a hint. Tested in `import-actions.test.ts`.

### Rollback

Worker-only PR over PR3's schema. Revert the merge commit to disable; queued jobs stay in `import_jobs` table at `status='queued'` and never drain. Operator can manually mark them `failed` from the dashboard (after a one-off SQL), or they expire. Schema rollback is the PR3 cleanup migration if and only if we abandon the whole feature.

### Estimated diff size

~500 LOC, 12 files (9 new + 3 modified).

---

## Cross-PR concerns

### Audit-log entries (final list)

- `data.exported` — inline CSV/JSON download (PR1).
- `data.export.queued`, `data.export.completed`, `data.export.failed` — full-backup job lifecycle (PR2).
- `data.import.queued`, `data.import.succeeded`, `data.import.failed` — import job lifecycle (PR4).

Each carries `metadata: { rowCounts, sizeBytes, source?, jobId }`. No PII.

### Subagent review checklist

Before merging each PR, run from `.claude/agents/`:

- `@code-reviewer` — every PR.
- `@gdpr-auditor` — PR1, PR2, PR4 (touch guest data).
- `@security-reviewer` — PR2 (Storage + signed URL + cross-tenant), PR4 (file upload + worker authorisation).

### Test coverage targets

- `lib/io/csv.ts` — 100% (small, security-critical).
- `lib/import/normalise.ts` — 100%.
- `lib/import/parsers/*` — golden fixtures + edge cases (BOM, CRLF, quoted commas, embedded newlines, trailing blank rows).
- `lib/export/*` — happy-path golden fixture + cross-tenant integration.

### Performance budget

- Inline export of 50k bookings: < 5s server time (decrypts dominate).
- Full-backup zip job for typical org: < 30s, < 50MB output.
- Import job for 50k rows: < 5min (spec AC). At 1k rows/chunk and ~80ms/row (encrypt + insert), expect ~2–3min on Supabase EU.

### Operator-visible flows (final)

- `/dashboard/data` — list of past exports + jobs, "Generate full backup" button, four "Download <entity> now" buttons.
- `/dashboard/data/jobs/<jobId>` — per-job status, download link if succeeded.
- `/dashboard/data/import` — Plus-only, file picker → format-detected → mapping wizard → preview → confirm.
- `/dashboard/data/import/<jobId>` — progress bar, counters, error-report download, link back to imported guests.

---

## Open questions for the operator

1. **Stripe Customer ID export.** Spec lists payments export as "with Stripe IDs for reconciliation". We have `payments.stripe_intent_id` and `guests.stripe_customer_id`. Confirm we surface the customer id as a column in the **payments** export (yes by default) and **don't** surface it in the guests export (no — it's a different audit trail).
2. **Erased guest rows in export.** Plan excludes `WHERE erased_at IS NULL` — confirm. Alternative: include the row with PII columns blanked (matches dashboard rendering) for "this guest existed but was erased" provenance. Default unless told otherwise: **exclude**.
3. **Booking notes in export.** Currently a free-text `bookings.notes` column (plaintext). Confirm we can include it directly — operators do see this in the dashboard. Yes by default.
4. **Group-CRM and full backup.** When group CRM is enabled, full backup still produces *one* zip per org spanning all venues. Confirm — yes by default.
5. **Free-tier full backup cadence cap.** Should we throttle `requestFullBackup` (e.g. 1/day on free, unlimited on Plus) to bound Storage egress? Default: no cap at MVP; revisit when we see usage.

If any of (1)–(5) reverse the default, only PR2 / PR4 are affected; flag during review.
