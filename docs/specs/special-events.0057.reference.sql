-- REFERENCE migration for the special_events table (Phase 1).
--
-- NOT wired into drizzle/migrations/_journal.json on purpose: this branch
-- (feat/table-combining) already has snapshot drift — migration 0056 added
-- `table_combinations` without advancing the meta snapshot, so
-- `drizzle-kit generate` needs a TTY to reconcile and can't run headless.
--
-- To land this canonically:
--   1. Run `pnpm db:generate` in your terminal. It will emit ONE migration
--      covering both `table_combinations` (the pending drift) and
--      `special_events`, and advance the snapshot. Accept the "create table"
--      resolutions (they are new tables, not renames).
--   2. Append the RLS block at the bottom of this file to the generated
--      migration (drizzle does not emit RLS — see how 0056 hand-adds it).
--
-- The DDL below mirrors what generate will produce from the schema.ts change,
-- so you can eyeball the diff.

CREATE TYPE "public"."event_status" AS ENUM('draft', 'published', 'cancelled');--> statement-breakpoint
CREATE TABLE "special_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"venue_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"status" "event_status" DEFAULT 'draft' NOT NULL,
	"blocks_standard_bookings" boolean DEFAULT true NOT NULL,
	"block_scope" text DEFAULT 'window' NOT NULL,
	"external_ticket_url" text,
	"hero_photo_path" text,
	"currency" char(3) DEFAULT 'GBP' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "special_events_block_scope_check" CHECK ("block_scope" in ('window', 'whole_day')),
	CONSTRAINT "special_events_window_check" CHECK ("ends_at" > "starts_at")
);
--> statement-breakpoint
ALTER TABLE "special_events" ADD CONSTRAINT "special_events_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "special_events" ADD CONSTRAINT "special_events_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "special_events_venue_slug_unique" ON "special_events" USING btree ("venue_id","slug");--> statement-breakpoint
CREATE INDEX "special_events_venue_window_idx" ON "special_events" USING btree ("venue_id","starts_at","ends_at");--> statement-breakpoint
CREATE INDEX "special_events_org_idx" ON "special_events" USING btree ("organisation_id");--> statement-breakpoint
-- === RLS (hand-added; drizzle-kit does not emit policies) =====================
-- Org members can read their own venue's events (dashboard list + the public
-- closure loaders go through adminDb(), which bypasses RLS anyway). All writes
-- go through org-guarded server actions via adminDb(), so there is no
-- INSERT/UPDATE/DELETE policy for the authenticated role. Mirrors the
-- table_combinations / billing_* member-read posture (migration 0056).
ALTER TABLE "special_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "special_events_member_read" ON "special_events"
  FOR SELECT TO authenticated
  USING (organisation_id IN (SELECT public.user_organisation_ids()));
