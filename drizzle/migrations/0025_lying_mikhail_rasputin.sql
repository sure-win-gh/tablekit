-- =============================================================================
-- 0025: import_jobs — encrypted source CSV + pre-encrypt size
-- =============================================================================
--
-- Adds two nullable columns to `import_jobs` so the runner (PR3b) has
-- the operator's CSV available without a separate Storage bucket:
--
--   - `source_csv_cipher` — envelope-encrypted CSV text. The runner
--     decrypts via lib/security/crypto.ts:decryptPii using the org's
--     wrapped DEK. Plaintext is never written here; the column-level
--     encryption is required by gdpr.md §Encryption (Supabase TDE
--     alone is the at-rest layer, not the column-level guarantee).
--   - `source_size_bytes` — pre-encrypt byte count, used to enforce
--     the 50MB upload cap defensively (DB CHECK below mirrors the
--     upload-action limit).
--
-- The column-level encryption means the post-encrypt blob is ~33%
-- larger (base64 + IV/tag/version prefix). The CHECK on
-- `source_csv_cipher` accommodates that with headroom — 80MB is
-- enough for a 50MB plaintext CSV plus envelope overhead.
--
-- Forward-only, additive. No drops, no NOT NULL backfills.
-- =============================================================================

-- --- Drizzle-generated schema (DO NOT HAND-EDIT this block) ------------------
ALTER TABLE "import_jobs" ADD COLUMN "source_csv_cipher" text;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD COLUMN "source_size_bytes" integer;--> statement-breakpoint

-- --- Value constraints -------------------------------------------------------
-- Defence-in-depth cap on the cipher column. octet_length counts
-- bytes (not code points) so a CSV of 4-byte emoji can't slip past a
-- char-count cap and balloon on disk.
ALTER TABLE "import_jobs"
  ADD CONSTRAINT "import_jobs_source_csv_cipher_size_check"
  CHECK ("source_csv_cipher" IS NULL OR octet_length("source_csv_cipher") <= 83886080);--> statement-breakpoint

-- Pre-encrypt byte count: non-negative, ≤ 50MB. The upload action
-- enforces the same limit at the form layer; this is the DB-side
-- backstop.
ALTER TABLE "import_jobs"
  ADD CONSTRAINT "import_jobs_source_size_bytes_check"
  CHECK ("source_size_bytes" IS NULL OR ("source_size_bytes" >= 0 AND "source_size_bytes" <= 52428800));--> statement-breakpoint

-- Pair invariant: cipher + size move together. A row with one but
-- not the other is a bug — guard at the DB level.
ALTER TABLE "import_jobs"
  ADD CONSTRAINT "import_jobs_source_pair_check"
  CHECK (
    ("source_csv_cipher" IS NULL AND "source_size_bytes" IS NULL)
    OR ("source_csv_cipher" IS NOT NULL AND "source_size_bytes" IS NOT NULL)
  );
