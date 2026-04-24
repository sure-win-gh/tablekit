-- =============================================================================
-- 0006: payments-connect — stripe_accounts + stripe_events
-- =============================================================================
--
-- Drizzle generates the schema block; RLS + the updated_at touch
-- trigger on stripe_accounts are hand-appended below. stripe_events
-- is system-only — no RLS policies at all, which means the
-- authenticated role sees zero rows (RLS default-deny).
-- =============================================================================

-- --- Drizzle-generated schema (DO NOT HAND-EDIT this block) ------------------
CREATE TABLE "stripe_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"account_id" text NOT NULL,
	"charges_enabled" boolean DEFAULT false NOT NULL,
	"payouts_enabled" boolean DEFAULT false NOT NULL,
	"details_submitted" boolean DEFAULT false NOT NULL,
	"country" char(2),
	"default_currency" char(3),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stripe_accounts_organisation_id_unique" UNIQUE("organisation_id"),
	CONSTRAINT "stripe_accounts_account_id_unique" UNIQUE("account_id")
);
--> statement-breakpoint
CREATE TABLE "stripe_events" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"handled_at" timestamp with time zone,
	"payload" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "stripe_accounts" ADD CONSTRAINT "stripe_accounts_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stripe_events_type_idx" ON "stripe_events" USING btree ("type");--> statement-breakpoint
CREATE INDEX "stripe_events_unhandled_idx" ON "stripe_events" USING btree ("received_at") WHERE "stripe_events"."handled_at" is null;--> statement-breakpoint

-- --- updated_at touch for stripe_accounts -----------------------------------
CREATE OR REPLACE FUNCTION public.touch_stripe_accounts_updated_at()
  RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER touch_stripe_accounts_updated_at
  BEFORE UPDATE ON public.stripe_accounts
  FOR EACH ROW EXECUTE FUNCTION public.touch_stripe_accounts_updated_at();
--> statement-breakpoint

-- --- Row Level Security ------------------------------------------------------
ALTER TABLE "stripe_accounts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "stripe_events"   ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- Members of an organisation can read their own stripe_accounts row.
-- Writes route through adminDb from the onboarding action + webhook.
CREATE POLICY "stripe_accounts_member_read" ON "stripe_accounts"
  FOR SELECT TO authenticated
  USING (organisation_id IN (SELECT public.user_organisation_ids()));
--> statement-breakpoint

-- stripe_events: no policies. authenticated reads return zero rows.
-- (RLS default-deny + no SELECT policy = system-only table.)