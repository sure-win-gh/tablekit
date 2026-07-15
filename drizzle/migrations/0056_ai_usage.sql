-- =============================================================================
-- 0056: ai_usage — monthly Bedrock token ledger (ai-usage spec, PR 1/4)
-- =============================================================================
--
-- Per-(org, period, venue) tally of AI enquiry-parser calls and token
-- consumption. Cost is derived at read time from the price map in
-- lib/billing/ai-usage.ts — deliberately NOT stored (sub-penny per
-- call; a stored pence column would round to zero and freeze pricing
-- errors into history).
--
-- RLS mirrors message_usage: member SELECT via user_organisation_ids()
-- so the dashboard usage readout works under withUser. No
-- INSERT/UPDATE/DELETE policies — writes flow via adminDb() from the
-- enquiry runner only.
--
-- Forward-only, additive.
-- =============================================================================

CREATE TABLE "ai_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"venue_id" uuid NOT NULL,
	"period" text NOT NULL,
	"call_count" integer DEFAULT 0 NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_usage_org_period_venue_unique" ON "ai_usage" USING btree ("organisation_id","period","venue_id");--> statement-breakpoint
CREATE INDEX "ai_usage_venue_idx" ON "ai_usage" USING btree ("venue_id");--> statement-breakpoint

-- --- Value constraints -------------------------------------------------------
ALTER TABLE "ai_usage"
  ADD CONSTRAINT "ai_usage_period_shape_check"
  CHECK (period ~ '^\d{4}-\d{2}$');--> statement-breakpoint
ALTER TABLE "ai_usage"
  ADD CONSTRAINT "ai_usage_nonnegative_check"
  CHECK (call_count >= 0 AND input_tokens >= 0 AND output_tokens >= 0);--> statement-breakpoint

-- --- Row Level Security ------------------------------------------------------
ALTER TABLE "ai_usage" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "ai_usage_member_read" ON "ai_usage"
  FOR SELECT TO authenticated
  USING (organisation_id IN (SELECT public.user_organisation_ids()));
