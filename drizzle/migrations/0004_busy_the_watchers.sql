-- =============================================================================
-- 0004: bookings — bookings + booking_tables junction + booking_events
-- =============================================================================
--
-- Drizzle generates the schema block; everything below it is hand-
-- written: the btree_gist extension for the no-double-book constraint,
-- the denormalisation triggers (org/venue/area/time onto the junction),
-- a time-sync trigger so bookings.start_at/end_at changes propagate,
-- a status trigger that frees tables on cancellation, RLS, and the
-- EXCLUDE USING gist constraint itself.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS btree_gist;--> statement-breakpoint

-- --- Drizzle-generated schema (DO NOT HAND-EDIT this block) ------------------
CREATE TYPE "public"."booking_status" AS ENUM('requested', 'confirmed', 'seated', 'finished', 'cancelled', 'no_show');--> statement-breakpoint
CREATE TABLE "booking_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"booking_id" uuid NOT NULL,
	"type" text NOT NULL,
	"actor_user_id" uuid,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "booking_tables" (
	"booking_id" uuid NOT NULL,
	"table_id" uuid NOT NULL,
	"organisation_id" uuid NOT NULL,
	"venue_id" uuid NOT NULL,
	"area_id" uuid NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone NOT NULL,
	CONSTRAINT "booking_tables_booking_id_table_id_pk" PRIMARY KEY("booking_id","table_id")
);
--> statement-breakpoint
CREATE TABLE "bookings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"venue_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"area_id" uuid NOT NULL,
	"guest_id" uuid NOT NULL,
	"party_size" integer NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone NOT NULL,
	"status" "booking_status" DEFAULT 'confirmed' NOT NULL,
	"source" text NOT NULL,
	"deposit_intent_id" text,
	"notes" text,
	"booked_by_user_id" uuid,
	"cancelled_at" timestamp with time zone,
	"cancelled_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "booking_events" ADD CONSTRAINT "booking_events_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_events" ADD CONSTRAINT "booking_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_tables" ADD CONSTRAINT "booking_tables_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_tables" ADD CONSTRAINT "booking_tables_table_id_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."tables"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_area_id_areas_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."areas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_guest_id_guests_id_fk" FOREIGN KEY ("guest_id") REFERENCES "public"."guests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_booked_by_user_id_users_id_fk" FOREIGN KEY ("booked_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "booking_events_booking_idx" ON "booking_events" USING btree ("booking_id","created_at");--> statement-breakpoint
CREATE INDEX "booking_events_org_idx" ON "booking_events" USING btree ("organisation_id");--> statement-breakpoint
CREATE INDEX "booking_tables_table_idx" ON "booking_tables" USING btree ("table_id");--> statement-breakpoint
CREATE INDEX "booking_tables_org_idx" ON "booking_tables" USING btree ("organisation_id");--> statement-breakpoint
CREATE INDEX "bookings_venue_start_idx" ON "bookings" USING btree ("venue_id","start_at");--> statement-breakpoint
CREATE INDEX "bookings_org_idx" ON "bookings" USING btree ("organisation_id");--> statement-breakpoint
CREATE INDEX "bookings_guest_idx" ON "bookings" USING btree ("guest_id");--> statement-breakpoint

-- --- CHECK constraints -------------------------------------------------------
ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_party_size_check" CHECK ("party_size" BETWEEN 1 AND 20);--> statement-breakpoint
ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_time_ordered_check" CHECK ("end_at" > "start_at");--> statement-breakpoint
ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_source_check"
  CHECK ("source" IN ('host', 'widget', 'rwg', 'api'));--> statement-breakpoint

-- --- Denormalisation + sync triggers -----------------------------------------

-- bookings: copy organisation_id + venue_id from the parent service,
-- and sanity-check that the chosen area belongs to the same venue.
CREATE OR REPLACE FUNCTION public.enforce_bookings_org_and_venue()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
DECLARE
  svc_org uuid;
  svc_venue uuid;
  area_venue uuid;
BEGIN
  SELECT s.organisation_id, s.venue_id INTO svc_org, svc_venue
  FROM public.services s WHERE s.id = NEW.service_id;
  IF svc_org IS NULL THEN
    RAISE EXCEPTION 'enforce_bookings_org_and_venue: service % not found', NEW.service_id;
  END IF;
  NEW.organisation_id := svc_org;
  NEW.venue_id := svc_venue;

  SELECT a.venue_id INTO area_venue FROM public.areas a WHERE a.id = NEW.area_id;
  IF area_venue IS NULL THEN
    RAISE EXCEPTION 'enforce_bookings_org_and_venue: area % not found', NEW.area_id;
  END IF;
  IF area_venue <> svc_venue THEN
    RAISE EXCEPTION 'enforce_bookings_org_and_venue: area % belongs to a different venue than service %', NEW.area_id, NEW.service_id;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER enforce_bookings_org_and_venue
  BEFORE INSERT OR UPDATE OF service_id, area_id ON public.bookings
  FOR EACH ROW EXECUTE FUNCTION public.enforce_bookings_org_and_venue();
--> statement-breakpoint

-- booking_tables: copy org/venue/area/start_at/end_at from the parent
-- booking. Reject an insert whose table_id belongs to a different area
-- than the booking — this is the "same-area combinable" rule.
CREATE OR REPLACE FUNCTION public.enforce_booking_tables_denorm()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
DECLARE
  b_org uuid;
  b_venue uuid;
  b_area uuid;
  b_start timestamptz;
  b_end timestamptz;
  t_area uuid;
BEGIN
  SELECT organisation_id, venue_id, area_id, start_at, end_at
    INTO b_org, b_venue, b_area, b_start, b_end
  FROM public.bookings WHERE id = NEW.booking_id;
  IF b_org IS NULL THEN
    RAISE EXCEPTION 'enforce_booking_tables_denorm: booking % not found', NEW.booking_id;
  END IF;
  NEW.organisation_id := b_org;
  NEW.venue_id := b_venue;
  NEW.area_id := b_area;
  NEW.start_at := b_start;
  NEW.end_at := b_end;

  SELECT area_id INTO t_area FROM public.tables WHERE id = NEW.table_id;
  IF t_area IS NULL THEN
    RAISE EXCEPTION 'enforce_booking_tables_denorm: table % not found', NEW.table_id;
  END IF;
  IF t_area <> b_area THEN
    RAISE EXCEPTION 'enforce_booking_tables_denorm: table % is in area %, booking is in area % (same-area combinable rule)', NEW.table_id, t_area, b_area;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER enforce_booking_tables_denorm
  BEFORE INSERT ON public.booking_tables
  FOR EACH ROW EXECUTE FUNCTION public.enforce_booking_tables_denorm();
--> statement-breakpoint

-- If bookings.start_at / end_at changes, propagate to the junction so
-- the EXCLUDE constraint still reflects reality.
CREATE OR REPLACE FUNCTION public.sync_booking_tables_on_time_change()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
BEGIN
  IF NEW.start_at IS DISTINCT FROM OLD.start_at
     OR NEW.end_at IS DISTINCT FROM OLD.end_at THEN
    UPDATE public.booking_tables
      SET start_at = NEW.start_at, end_at = NEW.end_at
      WHERE booking_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER sync_booking_tables_on_time_change
  AFTER UPDATE OF start_at, end_at ON public.bookings
  FOR EACH ROW EXECUTE FUNCTION public.sync_booking_tables_on_time_change();
--> statement-breakpoint

-- When a booking is cancelled, free the tables. no_show is not cleared:
-- it happens after the scheduled window so the junction row is moot,
-- and keeping it preserves the history.
CREATE OR REPLACE FUNCTION public.clear_booking_tables_on_cancel()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'cancelled' AND OLD.status IS DISTINCT FROM 'cancelled' THEN
    DELETE FROM public.booking_tables WHERE booking_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER clear_booking_tables_on_cancel
  AFTER UPDATE OF status ON public.bookings
  FOR EACH ROW EXECUTE FUNCTION public.clear_booking_tables_on_cancel();
--> statement-breakpoint

-- booking_events: copy organisation_id from parent booking.
CREATE OR REPLACE FUNCTION public.enforce_booking_events_org_id()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
BEGIN
  SELECT organisation_id INTO NEW.organisation_id
  FROM public.bookings WHERE id = NEW.booking_id;
  IF NEW.organisation_id IS NULL THEN
    RAISE EXCEPTION 'enforce_booking_events_org_id: booking % not found', NEW.booking_id;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER enforce_booking_events_org_id
  BEFORE INSERT OR UPDATE OF booking_id ON public.booking_events
  FOR EACH ROW EXECUTE FUNCTION public.enforce_booking_events_org_id();
--> statement-breakpoint

-- updated_at touch for bookings.
CREATE OR REPLACE FUNCTION public.touch_bookings_updated_at()
  RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER touch_bookings_updated_at
  BEFORE UPDATE ON public.bookings
  FOR EACH ROW EXECUTE FUNCTION public.touch_bookings_updated_at();
--> statement-breakpoint

-- --- The main event: no double-booking ---------------------------------------
ALTER TABLE "booking_tables"
  ADD CONSTRAINT "booking_tables_no_double_book"
  EXCLUDE USING gist (
    "table_id" WITH =,
    tstzrange("start_at", "end_at", '[)') WITH &&
  );--> statement-breakpoint

-- --- Row Level Security ------------------------------------------------------
ALTER TABLE "bookings"        ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "booking_tables"  ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "booking_events"  ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "bookings_member_read" ON "bookings"
  FOR SELECT TO authenticated
  USING (organisation_id IN (SELECT public.user_organisation_ids()));
--> statement-breakpoint

CREATE POLICY "booking_tables_member_read" ON "booking_tables"
  FOR SELECT TO authenticated
  USING (organisation_id IN (SELECT public.user_organisation_ids()));
--> statement-breakpoint

CREATE POLICY "booking_events_member_read" ON "booking_events"
  FOR SELECT TO authenticated
  USING (organisation_id IN (SELECT public.user_organisation_ids()));