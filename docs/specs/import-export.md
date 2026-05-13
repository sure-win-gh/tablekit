# Spec: Import from competitors, export anytime

**Status:** shipped (full-backup zip + signed-URL job deferred — see footer)
**Depends on:** `guests.md`, `bookings.md`

## What we're building

Zero-friction onboarding by importing guest lists and upcoming bookings from OpenTable, ResDiary, SevenRooms, Quandoo, Resy exports. And a comprehensive export so operators never feel locked in.

## Why this matters

Switching cost is the #1 objection from operators on incumbent platforms. If we can get their guest history in and get them up and running in 30 minutes, we remove the biggest friction point. The counterpart — "export anything, anytime" — is what lets them say yes without fear.

## Import (Plus tier)

### Supported sources (launch set)

1. **OpenTable** — exported guest list CSV.
2. **ResDiary** — exported guest list CSV.
3. **SevenRooms** — exported guest list CSV.
4. **Generic CSV** — column mapping wizard.

Not launch: live API imports from these platforms (terms often prohibit, and files are good enough).

### Flow

1. Operator uploads CSV in dashboard.
2. We detect format by column headers.
3. Column mapping wizard confirms mapping (with overrides).
4. Preview shows 10 rows pre-import.
5. Import runs as a background job. Operator sees progress and summary.
6. Dedupe by email+phone hash within the organisation. Conflicting rows → latest wins for notes, unions for tags.
7. Marketing consent is **never imported as granted** — the legal basis didn't transfer. Operator must re-opt-in.

### Acceptance criteria (import)

- [ ] CSVs up to 50k rows import within 5 minutes. Manual launch-readiness check — not codified in CI.
- [x] Dedupe runs during import, not as a separate step. Two passes: [`lib/import/dedupe.ts`](../../lib/import/dedupe.ts) (within-file, latest wins) + [`lib/import/runner/dedupe-existing.ts`](../../lib/import/runner/dedupe-existing.ts) (cross-org against `guests.email_hash`).
- [x] Imported guests have `imported_from` + `imported_at` metadata for provenance. `guests.importedFrom` text + `guests.importedAt` timestamptz columns ([`lib/db/schema.ts`](../../lib/db/schema.ts)).
- [x] Marketing consent flags always null on import. Enforced in [`lib/import/runner/writer.ts`](../../lib/import/runner/writer.ts) regardless of column-map content — the spec rule that "consent never imports as granted" is encoded as `marketingConsentAt: null` at write time.
- [x] Rejected rows exported to a downloadable report. Runner stamps an envelope-encrypted CSV into `import_jobs.rejected_rows_cipher` ([`lib/import/rejected-csv.ts`](../../lib/import/rejected-csv.ts) builds the RFC 4180 + UTF-8 BOM + formula-injection-guarded CSV); operator clicks "Download rejected rows" on the job detail page → [`/api/imports/[jobId]/rejected.csv`](../../app/api/imports/[jobId]/rejected.csv/route.ts) decrypts + streams + audits.
- [x] Job is resumable — crash mid-import doesn't double-insert. The runner writes a sentinel row per source row before the actual insert (`writer.ts`) so a crash leaves an honest count and a re-run is a no-op rather than a duplicate.

## Export (MVP)

Available from day one on every tier. This is the promise.

### Exports available

- All bookings (JSON + CSV).
- All guests (JSON + CSV).
- All messages (JSON).
- All payments (CSV, with Stripe IDs for reconciliation).
- Full org backup (one zip, all of the above + schema documentation).

### Acceptance criteria (export)

- [x] Available from dashboard Settings → Data. Routes under [`app/(dashboard)/dashboard/data/export/[entity]/`](../../app/(dashboard)/dashboard/data/export/[entity]/route.ts) — bookings + guests inline downloads.
- [ ] Full backup export runs as a background job; link emailed when ready. **Deferred.** The export route's own header comment ("zip lands in PR2 with the job table + signed URLs") documents the split — PR1 shipped the inline path; the zip+job path waits for the first operator to ask.
- [x] Encrypted PII columns decrypted in the export. The route calls `decryptPii(orgId, …)` before serialising — the owning org sees its own data in plaintext, matching gdpr.md's "operator is data controller" posture.
- [x] Exports logged in `audit_log`. Action `data.exported` written from [`app/(dashboard)/dashboard/data/export/[entity]/route.ts`](../../app/(dashboard)/dashboard/data/export/[entity]/route.ts).
- [ ] Export URL signed, single-use, expires after 24h. **Deferred** alongside the background-job path — only inline streaming today, so signing isn't needed yet.

## Deferred

### Full-backup zip + background-job export pipeline

Inline streaming (bookings + guests) is the v1. The full-backup spec calls for a zipped bundle of everything (bookings + guests + messages + payments + schema doc) generated as a background job, with an emailed signed URL that expires after 24h. Substantial — needs an `export_jobs` table, a worker, Supabase Storage write, signed-URL minting. Pull when an operator asks for "give me everything in one file".

### 50k-in-5min performance check

Manual launch-readiness benchmark. Run against a representative CSV with a fresh org; capture wall-clock + rejected count. Not codified in CI — would need a long-running perf harness.
