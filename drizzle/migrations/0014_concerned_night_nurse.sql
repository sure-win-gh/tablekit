CREATE TYPE "public"."review_source" AS ENUM('internal', 'google', 'tripadvisor', 'facebook');--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"venue_id" uuid NOT NULL,
	"booking_id" uuid NOT NULL,
	"guest_id" uuid NOT NULL,
	"rating" integer NOT NULL,
	"comment_cipher" text,
	"source" "review_source" DEFAULT 'internal' NOT NULL,
	"redirected_to_external" boolean DEFAULT false NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reviews_booking_id_unique" UNIQUE("booking_id")
);
--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_guest_id_guests_id_fk" FOREIGN KEY ("guest_id") REFERENCES "public"."guests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reviews_venue_idx" ON "reviews" USING btree ("venue_id","submitted_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "reviews_org_idx" ON "reviews" USING btree ("organisation_id");--> statement-breakpoint
CREATE INDEX "reviews_guest_idx" ON "reviews" USING btree ("guest_id");--> statement-breakpoint

-- --- Value constraints -------------------------------------------------------
ALTER TABLE "reviews"
  ADD CONSTRAINT "reviews_rating_range_check"
  CHECK (rating BETWEEN 1 AND 5);--> statement-breakpoint

-- --- Denormalisation trigger -------------------------------------------------
-- Copies organisation_id + venue_id from the parent booking on insert.
-- Matches the enforce_messages_org_id pattern; SECURITY DEFINER lets us
-- read the parent regardless of the caller's RLS context.
CREATE OR REPLACE FUNCTION public.enforce_reviews_org_and_venue()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
BEGIN
  SELECT b.organisation_id, b.venue_id
    INTO NEW.organisation_id, NEW.venue_id
  FROM public.bookings b WHERE b.id = NEW.booking_id;
  IF NEW.organisation_id IS NULL OR NEW.venue_id IS NULL THEN
    RAISE EXCEPTION 'enforce_reviews_org_and_venue: parent booking % not found', NEW.booking_id;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER enforce_reviews_org_and_venue
  BEFORE INSERT OR UPDATE OF booking_id ON public.reviews
  FOR EACH ROW EXECUTE FUNCTION public.enforce_reviews_org_and_venue();
--> statement-breakpoint

-- --- updated_at touch trigger ------------------------------------------------
CREATE OR REPLACE FUNCTION public.touch_reviews_updated_at()
  RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER touch_reviews_updated_at
  BEFORE UPDATE ON public.reviews
  FOR EACH ROW EXECUTE FUNCTION public.touch_reviews_updated_at();
--> statement-breakpoint

-- --- Row Level Security ------------------------------------------------------
-- Per-venue scoping (matches bookings_member_read in 0013). Writes go
-- through adminDb() in server actions / public submission handler —
-- no INSERT/UPDATE/DELETE policies for the authenticated role.
ALTER TABLE "reviews" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "reviews_member_read" ON "reviews"
  FOR SELECT TO authenticated
  USING (venue_id IN (SELECT public.user_visible_venue_ids()));
--> statement-breakpoint

-- --- Extend messages template CHECK to allow review_request ------------------
-- Drop the existing CHECK from 0009 and recreate with the new template.
ALTER TABLE "messages" DROP CONSTRAINT IF EXISTS "messages_template_check";--> statement-breakpoint
ALTER TABLE "messages"
  ADD CONSTRAINT "messages_template_check"
  CHECK (template IN (
    'booking.confirmation',
    'booking.reminder_24h',
    'booking.reminder_2h',
    'booking.cancelled',
    'booking.thank_you',
    'booking.waitlist_ready',
    'booking.review_request'
  ));