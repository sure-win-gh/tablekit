-- =============================================================================
-- 0024: import_jobs — bulk-import job queue + guest provenance
-- =============================================================================
--
-- Tracks one row per CSV upload. Lifecycle is linear:
-- queued → parsing → preview_ready → importing → completed | failed.
-- Writes flow through adminDb() (creation from the dashboard action,
-- progress updates from the cron runner). RLS restricts SELECT to org
-- members; no INSERT/UPDATE/DELETE policies for the authenticated role
-- — matches the dsar_requests pattern.
--
-- Also adds nullable provenance columns to `guests` so we can answer
-- "how many of these came from migrating off OpenTable?" without
-- joining back to import_jobs (the FK is intentionally not stored
-- here yet; later PRs in this series may add it).
--
-- Forward-only, additive. No drops, no NOT NULL backfills.
-- =============================================================================

-- --- Drizzle-generated schema (DO NOT HAND-EDIT this block) ------------------
CREATE TABLE "import_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"source" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"filename" text NOT NULL,
	"row_count_total" integer,
	"row_count_imported" integer DEFAULT 0 NOT NULL,
	"row_count_rejected" integer DEFAULT 0 NOT NULL,
	"column_map" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"rejected_rows_url" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "guests" ADD COLUMN "imported_from" text;--> statement-breakpoint
ALTER TABLE "guests" ADD COLUMN "imported_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "import_jobs_org_created_idx" ON "import_jobs" USING btree ("organisation_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "import_jobs_active_idx" ON "import_jobs" USING btree ("created_at") WHERE "import_jobs"."status" in ('queued','parsing','importing');--> statement-breakpoint

-- --- Value constraints -------------------------------------------------------
-- Pin the source + status enums at the database level so a typo in
-- application code can't silently drift the lifecycle. Source values
-- mirror what gets written into `guests.imported_from` — the matching
-- CHECK on that column below keeps the two in lockstep.
ALTER TABLE "import_jobs"
  ADD CONSTRAINT "import_jobs_source_check"
  CHECK (source IN ('opentable', 'resdiary', 'sevenrooms', 'generic-csv'));--> statement-breakpoint
ALTER TABLE "import_jobs"
  ADD CONSTRAINT "import_jobs_status_check"
  CHECK (status IN ('queued', 'parsing', 'preview_ready', 'importing', 'completed', 'failed'));--> statement-breakpoint

-- Defence-in-depth length cap on the `error` column. Postgres + driver
-- error messages routinely echo offending input ("duplicate key value
-- ... (email_hash)=(<value>)"), and this column is NOT encrypted. The
-- runner PR will introduce a `sanitiseImportError()` boundary helper;
-- this cap prevents an un-sanitised string from being persisted in
-- the meantime. 500 chars is enough for a short reason + code.
ALTER TABLE "import_jobs"
  ADD CONSTRAINT "import_jobs_error_length_check"
  CHECK ("error" IS NULL OR length("error") <= 500);--> statement-breakpoint

-- Match `guests.imported_from` to the `import_jobs.source` enum so the
-- two stay in lockstep. Nullable for guests created via the booking
-- flow / dashboard.
ALTER TABLE "guests"
  ADD CONSTRAINT "guests_imported_from_check"
  CHECK ("imported_from" IS NULL OR "imported_from" IN ('opentable', 'resdiary', 'sevenrooms', 'generic-csv'));--> statement-breakpoint

-- --- updated_at touch trigger ------------------------------------------------
CREATE OR REPLACE FUNCTION public.touch_import_jobs_updated_at()
  RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER touch_import_jobs_updated_at
  BEFORE UPDATE ON public.import_jobs
  FOR EACH ROW EXECUTE FUNCTION public.touch_import_jobs_updated_at();
--> statement-breakpoint

-- --- Row Level Security ------------------------------------------------------
ALTER TABLE "import_jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- Members of an organisation can read their own org's import jobs.
-- All writes (creation from the dashboard, progress updates from the
-- runner) go via adminDb() with manual org-scope checks. No
-- INSERT/UPDATE/DELETE policies for the authenticated role — matches
-- dsar_requests / messages / payments.
CREATE POLICY "import_jobs_member_read" ON "import_jobs"
  FOR SELECT TO authenticated
  USING (organisation_id IN (SELECT public.user_organisation_ids()));
