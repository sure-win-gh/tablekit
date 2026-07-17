CREATE TABLE "campaign_link_clicks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"campaign_send_id" uuid NOT NULL,
	"url" text NOT NULL,
	"first_clicked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "campaign_link_clicks" ADD CONSTRAINT "campaign_link_clicks_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_link_clicks" ADD CONSTRAINT "campaign_link_clicks_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_link_clicks" ADD CONSTRAINT "campaign_link_clicks_campaign_send_id_campaign_sends_id_fk" FOREIGN KEY ("campaign_send_id") REFERENCES "public"."campaign_sends"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_link_clicks_send_url_unique" ON "campaign_link_clicks" USING btree ("campaign_send_id","url");--> statement-breakpoint
CREATE INDEX "campaign_link_clicks_campaign_idx" ON "campaign_link_clicks" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "campaign_link_clicks_org_idx" ON "campaign_link_clicks" USING btree ("organisation_id");--> statement-breakpoint

-- Marketing-suite Phase C: per-URL click tracking for the per-campaign
-- report. One row per (campaign_send, url); the unique index above makes a
-- repeat click on the same link idempotent, so the report counts UNIQUE
-- clickers per URL, not raw volume. Written adminDb-only from the Resend
-- webhook (email.clicked). We persist only the URL, never the IP /
-- user-agent Resend includes in the click payload.
--
-- Behavioural data keyed to a guest through campaign_send_id — the FK
-- cascades on delete, so guest erasure (lib/dsar/scrub.ts deletes the
-- guest's campaign_sends) and the 24-month retention sweep
-- (lib/campaigns/retention.ts) both remove these rows with no extra scrub.

-- Populate organisation_id from the parent campaign (defence in depth —
-- the webhook already supplies it, but the trigger guarantees the row can
-- never be mis-tenanted). Mirrors enforce_campaign_sends_org_id.
CREATE OR REPLACE FUNCTION public.enforce_campaign_link_clicks_org_id()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  SELECT organisation_id INTO NEW.organisation_id FROM public.campaigns WHERE id = NEW.campaign_id;
  IF NEW.organisation_id IS NULL THEN
    RAISE EXCEPTION 'enforce_campaign_link_clicks_org_id: parent campaign % not found', NEW.campaign_id;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER enforce_campaign_link_clicks_org_id
  BEFORE INSERT OR UPDATE OF campaign_id ON public.campaign_link_clicks
  FOR EACH ROW EXECUTE FUNCTION public.enforce_campaign_link_clicks_org_id();
--> statement-breakpoint

-- Row Level Security: org members can read their link clicks. All writes
-- go through the Resend webhook via adminDb() (org-guarded), so no
-- INSERT/UPDATE/DELETE policy for the authenticated role.
ALTER TABLE "campaign_link_clicks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "campaign_link_clicks_member_read" ON "campaign_link_clicks"
  FOR SELECT TO authenticated
  USING (organisation_id IN (SELECT public.user_organisation_ids()));