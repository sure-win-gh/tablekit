-- =============================================================================
-- 0009: messaging — messages table + guest unsubscribe state
-- =============================================================================
--
-- Drizzle generates the schema block; denormalisation trigger, RLS
-- policies, updated_at touch trigger, and CHECK constraints appended
-- below. Unsubscribe arrays + invalid-contact flags land on `guests`.
--
-- Forward-only, additive. The new guest columns have non-null
-- defaults so existing rows backfill at migration time.
-- =============================================================================

-- --- Drizzle-generated schema (DO NOT HAND-EDIT this block) ------------------
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"booking_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"template" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"provider_id" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"error" text,
	"sent_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "guests" ADD COLUMN "email_unsubscribed_venues" uuid[] DEFAULT ARRAY[]::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "guests" ADD COLUMN "sms_unsubscribed_venues" uuid[] DEFAULT ARRAY[]::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "guests" ADD COLUMN "email_invalid" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "guests" ADD COLUMN "phone_invalid" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "messages_booking_template_channel_unique" ON "messages" USING btree ("booking_id","template","channel");--> statement-breakpoint
CREATE INDEX "messages_booking_idx" ON "messages" USING btree ("booking_id");--> statement-breakpoint
CREATE INDEX "messages_org_idx" ON "messages" USING btree ("organisation_id");--> statement-breakpoint
CREATE INDEX "messages_worker_idx" ON "messages" USING btree ("next_attempt_at") WHERE "messages"."status" in ('queued','sending');--> statement-breakpoint

-- --- Value constraints -------------------------------------------------------
-- Channel + template + status are free-text in Drizzle; CHECKs pin
-- the domain so a typo can't quietly insert garbage. Templates list
-- is the spec's starter set; new templates land via migration as
-- they're added.
ALTER TABLE "messages"
  ADD CONSTRAINT "messages_channel_check"
  CHECK (channel IN ('email', 'sms'));--> statement-breakpoint
ALTER TABLE "messages"
  ADD CONSTRAINT "messages_status_check"
  CHECK (status IN ('queued', 'sending', 'sent', 'delivered', 'bounced', 'failed'));--> statement-breakpoint
ALTER TABLE "messages"
  ADD CONSTRAINT "messages_template_check"
  CHECK (template IN (
    'booking.confirmation',
    'booking.reminder_24h',
    'booking.reminder_2h',
    'booking.cancelled',
    'booking.thank_you',
    'booking.waitlist_ready'
  ));--> statement-breakpoint
ALTER TABLE "messages"
  ADD CONSTRAINT "messages_attempts_nonneg_check"
  CHECK (attempts >= 0);--> statement-breakpoint

-- --- Denormalisation trigger -------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_messages_org_id()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
BEGIN
  SELECT organisation_id INTO NEW.organisation_id
  FROM public.bookings WHERE id = NEW.booking_id;
  IF NEW.organisation_id IS NULL THEN
    RAISE EXCEPTION 'enforce_messages_org_id: parent booking % not found', NEW.booking_id;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER enforce_messages_org_id
  BEFORE INSERT OR UPDATE OF booking_id ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.enforce_messages_org_id();
--> statement-breakpoint

-- --- updated_at touch trigger ------------------------------------------------
CREATE OR REPLACE FUNCTION public.touch_messages_updated_at()
  RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER touch_messages_updated_at
  BEFORE UPDATE ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.touch_messages_updated_at();
--> statement-breakpoint

-- --- Row Level Security ------------------------------------------------------
ALTER TABLE "messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- Members of an organisation can read their messages. All writes go
-- through dispatch via adminDb(). No INSERT / UPDATE / DELETE policies
-- for the authenticated role.
CREATE POLICY "messages_member_read" ON "messages"
  FOR SELECT TO authenticated
  USING (organisation_id IN (SELECT public.user_organisation_ids()));
