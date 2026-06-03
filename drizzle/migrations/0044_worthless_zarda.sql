CREATE TABLE "message_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"venue_id" uuid NOT NULL,
	"template" text NOT NULL,
	"channel" text NOT NULL,
	"subject_override" text,
	"body_override" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "message_templates_venue_template_channel_unique" ON "message_templates" USING btree ("venue_id","template","channel");--> statement-breakpoint
CREATE INDEX "message_templates_org_idx" ON "message_templates" USING btree ("organisation_id");--> statement-breakpoint
CREATE INDEX "message_templates_venue_idx" ON "message_templates" USING btree ("venue_id");--> statement-breakpoint

-- --- Value constraints -------------------------------------------------------
ALTER TABLE "message_templates"
  ADD CONSTRAINT "message_templates_channel_check"
  CHECK (channel IN ('email', 'sms', 'whatsapp'));--> statement-breakpoint
ALTER TABLE "message_templates"
  ADD CONSTRAINT "message_templates_template_check"
  CHECK (template IN (
    'booking.confirmation',
    'booking.reminder_24h',
    'booking.reminder_2h',
    'booking.cancelled',
    'booking.thank_you',
    'booking.waitlist_ready',
    'booking.review_request',
    'review.operator_reply',
    'review.recovery_offer'
  ));--> statement-breakpoint

-- --- Denormalisation trigger: sync organisation_id from parent venue ---------
CREATE OR REPLACE FUNCTION public.enforce_message_templates_org_id()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
BEGIN
  SELECT organisation_id INTO NEW.organisation_id
  FROM public.venues WHERE id = NEW.venue_id;
  IF NEW.organisation_id IS NULL THEN
    RAISE EXCEPTION 'enforce_message_templates_org_id: parent venue % not found', NEW.venue_id;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER enforce_message_templates_org_id
  BEFORE INSERT OR UPDATE OF venue_id ON public.message_templates
  FOR EACH ROW EXECUTE FUNCTION public.enforce_message_templates_org_id();
--> statement-breakpoint

-- --- updated_at touch trigger ------------------------------------------------
CREATE OR REPLACE FUNCTION public.touch_message_templates_updated_at()
  RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER touch_message_templates_updated_at
  BEFORE UPDATE ON public.message_templates
  FOR EACH ROW EXECUTE FUNCTION public.touch_message_templates_updated_at();
--> statement-breakpoint

-- --- Row Level Security ------------------------------------------------------
ALTER TABLE "message_templates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- Members of an organisation can read their venues' message templates.
-- All writes go through the settings server action via adminDb() (which
-- bypasses RLS, guarded by an org check in the action), so no
-- INSERT/UPDATE/DELETE policy for the authenticated role.
CREATE POLICY "message_templates_member_read" ON "message_templates"
  FOR SELECT TO authenticated
  USING (organisation_id IN (SELECT public.user_organisation_ids()));