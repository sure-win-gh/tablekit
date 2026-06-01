CREATE TABLE "campaign_sends" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"guest_id" uuid NOT NULL,
	"venue_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"provider_id" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"opened_at" timestamp with time zone,
	"clicked_at" timestamp with time zone,
	"error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"venue_id" uuid NOT NULL,
	"name" text NOT NULL,
	"channel" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"subject_override" text,
	"body" text NOT NULL,
	"scheduled_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"period" text NOT NULL,
	"channel" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"est_cost_pence" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "campaign_sends" ADD CONSTRAINT "campaign_sends_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_sends" ADD CONSTRAINT "campaign_sends_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_sends" ADD CONSTRAINT "campaign_sends_guest_id_guests_id_fk" FOREIGN KEY ("guest_id") REFERENCES "public"."guests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_sends" ADD CONSTRAINT "campaign_sends_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_usage" ADD CONSTRAINT "message_usage_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_sends_campaign_guest_channel_unique" ON "campaign_sends" USING btree ("campaign_id","guest_id","channel");--> statement-breakpoint
CREATE INDEX "campaign_sends_campaign_idx" ON "campaign_sends" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "campaign_sends_org_idx" ON "campaign_sends" USING btree ("organisation_id");--> statement-breakpoint
CREATE INDEX "campaign_sends_provider_idx" ON "campaign_sends" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX "campaign_sends_worker_idx" ON "campaign_sends" USING btree ("next_attempt_at") WHERE "campaign_sends"."status" in ('queued','sending');--> statement-breakpoint
CREATE INDEX "campaigns_org_idx" ON "campaigns" USING btree ("organisation_id");--> statement-breakpoint
CREATE INDEX "campaigns_venue_idx" ON "campaigns" USING btree ("venue_id");--> statement-breakpoint
CREATE UNIQUE INDEX "message_usage_org_period_channel_unique" ON "message_usage" USING btree ("organisation_id","period","channel");--> statement-breakpoint
CREATE INDEX "message_usage_org_idx" ON "message_usage" USING btree ("organisation_id");--> statement-breakpoint

-- --- Value constraints -------------------------------------------------------
ALTER TABLE "campaigns"
  ADD CONSTRAINT "campaigns_channel_check" CHECK (channel IN ('email', 'sms', 'whatsapp'));--> statement-breakpoint
ALTER TABLE "campaigns"
  ADD CONSTRAINT "campaigns_status_check"
  CHECK (status IN ('draft', 'scheduled', 'sending', 'sent', 'cancelled'));--> statement-breakpoint
ALTER TABLE "campaign_sends"
  ADD CONSTRAINT "campaign_sends_channel_check" CHECK (channel IN ('email', 'sms', 'whatsapp'));--> statement-breakpoint
ALTER TABLE "campaign_sends"
  ADD CONSTRAINT "campaign_sends_status_check"
  CHECK (status IN ('queued', 'sending', 'sent', 'delivered', 'bounced', 'failed'));--> statement-breakpoint
ALTER TABLE "campaign_sends"
  ADD CONSTRAINT "campaign_sends_attempts_nonneg_check" CHECK (attempts >= 0);--> statement-breakpoint
ALTER TABLE "message_usage"
  ADD CONSTRAINT "message_usage_channel_check" CHECK (channel IN ('email', 'sms', 'whatsapp'));--> statement-breakpoint

-- --- Denormalisation triggers: sync organisation_id from the parent ----------
CREATE OR REPLACE FUNCTION public.enforce_campaigns_org_id()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  SELECT organisation_id INTO NEW.organisation_id FROM public.venues WHERE id = NEW.venue_id;
  IF NEW.organisation_id IS NULL THEN
    RAISE EXCEPTION 'enforce_campaigns_org_id: parent venue % not found', NEW.venue_id;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER enforce_campaigns_org_id
  BEFORE INSERT OR UPDATE OF venue_id ON public.campaigns
  FOR EACH ROW EXECUTE FUNCTION public.enforce_campaigns_org_id();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.enforce_campaign_sends_org_id()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  SELECT organisation_id INTO NEW.organisation_id FROM public.campaigns WHERE id = NEW.campaign_id;
  IF NEW.organisation_id IS NULL THEN
    RAISE EXCEPTION 'enforce_campaign_sends_org_id: parent campaign % not found', NEW.campaign_id;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER enforce_campaign_sends_org_id
  BEFORE INSERT OR UPDATE OF campaign_id ON public.campaign_sends
  FOR EACH ROW EXECUTE FUNCTION public.enforce_campaign_sends_org_id();
--> statement-breakpoint

-- --- updated_at touch triggers -----------------------------------------------
CREATE OR REPLACE FUNCTION public.touch_campaigns_updated_at()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;
--> statement-breakpoint
CREATE TRIGGER touch_campaigns_updated_at
  BEFORE UPDATE ON public.campaigns
  FOR EACH ROW EXECUTE FUNCTION public.touch_campaigns_updated_at();
--> statement-breakpoint
CREATE TRIGGER touch_campaign_sends_updated_at
  BEFORE UPDATE ON public.campaign_sends
  FOR EACH ROW EXECUTE FUNCTION public.touch_campaigns_updated_at();
--> statement-breakpoint
CREATE TRIGGER touch_message_usage_updated_at
  BEFORE UPDATE ON public.message_usage
  FOR EACH ROW EXECUTE FUNCTION public.touch_campaigns_updated_at();
--> statement-breakpoint

-- --- Row Level Security ------------------------------------------------------
-- Org members can read their campaigns/sends/usage. All writes go through
-- the dashboard actions + dispatch worker via adminDb() (org-guarded), so
-- no INSERT/UPDATE/DELETE policy for the authenticated role.
ALTER TABLE "campaigns" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "campaigns_member_read" ON "campaigns"
  FOR SELECT TO authenticated
  USING (organisation_id IN (SELECT public.user_organisation_ids()));--> statement-breakpoint
ALTER TABLE "campaign_sends" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "campaign_sends_member_read" ON "campaign_sends"
  FOR SELECT TO authenticated
  USING (organisation_id IN (SELECT public.user_organisation_ids()));--> statement-breakpoint
ALTER TABLE "message_usage" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "message_usage_member_read" ON "message_usage"
  FOR SELECT TO authenticated
  USING (organisation_id IN (SELECT public.user_organisation_ids()));