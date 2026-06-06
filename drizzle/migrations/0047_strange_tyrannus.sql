CREATE TABLE "billing_credit_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"delta_pence" integer NOT NULL,
	"reason" text NOT NULL,
	"ref" text,
	"balance_after" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"stripe_subscription_id" text NOT NULL,
	"status" text NOT NULL,
	"plan" text NOT NULL,
	"current_period_end" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_subscriptions_organisation_id_unique" UNIQUE("organisation_id"),
	CONSTRAINT "billing_subscriptions_stripe_subscription_id_unique" UNIQUE("stripe_subscription_id")
);
--> statement-breakpoint
ALTER TABLE "message_usage" ADD COLUMN "reported_pence" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "credit_balance_pence" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_credit_ledger" ADD CONSTRAINT "billing_credit_ledger_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD CONSTRAINT "billing_subscriptions_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_credit_ledger_reason_ref_unique" ON "billing_credit_ledger" USING btree ("reason","ref");--> statement-breakpoint
CREATE INDEX "billing_credit_ledger_org_idx" ON "billing_credit_ledger" USING btree ("organisation_id","created_at");--> statement-breakpoint

-- --- Value constraints -------------------------------------------------------
ALTER TABLE "billing_subscriptions"
  ADD CONSTRAINT "billing_subscriptions_plan_check" CHECK (plan IN ('core', 'plus'));--> statement-breakpoint
ALTER TABLE "billing_credit_ledger"
  ADD CONSTRAINT "billing_credit_ledger_reason_check"
  CHECK (reason IN ('topup', 'campaign_reserve', 'campaign_refund', 'adjustment'));--> statement-breakpoint

-- --- updated_at touch trigger (reuse the shared fn created in 0045) -----------
CREATE TRIGGER touch_billing_subscriptions_updated_at
  BEFORE UPDATE ON public.billing_subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.touch_campaigns_updated_at();--> statement-breakpoint

-- --- Row Level Security ------------------------------------------------------
-- Org members can read their own billing rows (dashboard plan + balance).
-- ALL writes go through the Stripe webhook / server actions via adminDb()
-- (org-guarded by requireRole), so no INSERT/UPDATE/DELETE policy for the
-- authenticated role. Mirrors the campaigns/message_usage posture in 0045.
ALTER TABLE "billing_subscriptions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "billing_subscriptions_member_read" ON "billing_subscriptions"
  FOR SELECT TO authenticated
  USING (organisation_id IN (SELECT public.user_organisation_ids()));--> statement-breakpoint
ALTER TABLE "billing_credit_ledger" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "billing_credit_ledger_member_read" ON "billing_credit_ledger"
  FOR SELECT TO authenticated
  USING (organisation_id IN (SELECT public.user_organisation_ids()));