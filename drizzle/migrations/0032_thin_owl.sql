-- =============================================================================
-- 0032: webhook_deliveries — outbound webhook attempt log (PR6b of public-api)
-- =============================================================================
--
-- One row per attempt to deliver an event to a subscription.
--
-- Lifecycle:
--   • Dispatcher INSERTs status='pending', attempts=0,
--     next_attempt_at=now().
--   • Cron picks pending rows due to fire (next_attempt_at <= now()),
--     POSTs the signed body, sets status='succeeded' on 2xx or
--     reschedules / marks failed on error.
--   • Retries: 5 total attempts, exponential backoff. After the 5th
--     failure status='failed', next_attempt_at=null.
--
-- RLS: deny-all from authenticated/anon. PR6c will add an org-scoped
-- read policy + dashboard delivery log + replay button. Until then
-- it's admin-only — operators have no read surface.
--
-- Forward-only, additive.
-- =============================================================================

-- --- Drizzle-generated schema (DO NOT HAND-EDIT this block) ------------------
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subscription_id" uuid NOT NULL,
	"organisation_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"event_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now(),
	"last_status" integer,
	"last_error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_subscription_id_webhook_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."webhook_subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "webhook_deliveries_due_idx" ON "webhook_deliveries" USING btree ("next_attempt_at") WHERE "webhook_deliveries"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "webhook_deliveries_org_created_idx" ON "webhook_deliveries" USING btree ("organisation_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "webhook_deliveries_subscription_idx" ON "webhook_deliveries" USING btree ("subscription_id");--> statement-breakpoint

-- --- Value constraints -------------------------------------------------------
ALTER TABLE "webhook_deliveries"
  ADD CONSTRAINT "webhook_deliveries_status_check"
  CHECK (status IN ('pending', 'succeeded', 'failed'));--> statement-breakpoint
ALTER TABLE "webhook_deliveries"
  ADD CONSTRAINT "webhook_deliveries_attempts_check"
  CHECK (attempts >= 0 AND attempts <= 5);--> statement-breakpoint
-- last_status, when set, must be a valid HTTP status. (0 reserved
-- for network/timeout failures — distinct from 5xx.)
ALTER TABLE "webhook_deliveries"
  ADD CONSTRAINT "webhook_deliveries_last_status_range_check"
  CHECK (last_status IS NULL OR last_status BETWEEN 0 AND 599);--> statement-breakpoint
-- Bounded last_error. Same shape as enquiries.error / import_jobs.error.
ALTER TABLE "webhook_deliveries"
  ADD CONSTRAINT "webhook_deliveries_last_error_length_check"
  CHECK (last_error IS NULL OR length(last_error) <= 500);--> statement-breakpoint

-- --- updated_at touch trigger ------------------------------------------------
CREATE OR REPLACE FUNCTION public.touch_webhook_deliveries_updated_at()
  RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER touch_webhook_deliveries_updated_at
  BEFORE UPDATE ON public.webhook_deliveries
  FOR EACH ROW EXECUTE FUNCTION public.touch_webhook_deliveries_updated_at();
--> statement-breakpoint

-- --- Row Level Security ------------------------------------------------------
-- Deny-all from authenticated/anon. All access via adminDb.
-- PR6c lifts the read side to org members for the dashboard log.
ALTER TABLE "webhook_deliveries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "webhook_deliveries_no_access" ON "webhook_deliveries"
  FOR ALL TO authenticated, anon
  USING (false)
  WITH CHECK (false);
