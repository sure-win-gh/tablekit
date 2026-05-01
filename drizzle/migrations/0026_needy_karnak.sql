-- =============================================================================
-- 0026: guests.import_job_id — DSAR linkage for bulk-import provenance
-- =============================================================================
--
-- Required by gdpr.md §DSAR step 4: when a guest is erased, the scrub
-- job must null `import_jobs.source_csv_cipher` for any job whose CSV
-- includes the erased guest. Without this column, that linkage is
-- unprovable — and source_csv_cipher persists for up to 7 days after
-- a `failed_at` (per the retention table) so a guest erasure during
-- that window must reach in to scrub.
--
-- ON DELETE SET NULL keeps the guest row alive when the parent
-- import_jobs row is purged at retention end (12 months from
-- completed_at / failed_at).
--
-- Forward-only, additive. Nullable — guests created via the booking
-- flow / dashboard never have an import_job_id.
-- =============================================================================

ALTER TABLE "guests" ADD COLUMN "import_job_id" uuid;--> statement-breakpoint
ALTER TABLE "guests" ADD CONSTRAINT "guests_import_job_id_import_jobs_id_fk" FOREIGN KEY ("import_job_id") REFERENCES "public"."import_jobs"("id") ON DELETE set null ON UPDATE no action;
