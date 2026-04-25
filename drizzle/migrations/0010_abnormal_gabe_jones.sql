-- =============================================================================
-- 0010: waitlist — waitlists table + extend bookings.source domain
-- =============================================================================
--
-- Drizzle generates the schema block; denormalisation trigger, RLS,
-- updated_at touch, and CHECK constraints appended below. Also widens
-- bookings_source_check to admit 'walk-in' since the seat-from-
-- waitlist flow creates bookings with that source.
--
-- Forward-only, additive. Existing bookings unaffected; new check
-- constraint is a strict superset.
-- =============================================================================

-- --- Drizzle-generated schema (DO NOT HAND-EDIT this block) ------------------
CREATE TABLE "waitlists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"venue_id" uuid NOT NULL,
	"guest_id" uuid NOT NULL,
	"party_size" integer NOT NULL,
	"status" text DEFAULT 'waiting' NOT NULL,
	"seated_booking_id" uuid,
	"notes" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"seated_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "waitlists" ADD CONSTRAINT "waitlists_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlists" ADD CONSTRAINT "waitlists_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlists" ADD CONSTRAINT "waitlists_guest_id_guests_id_fk" FOREIGN KEY ("guest_id") REFERENCES "public"."guests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlists" ADD CONSTRAINT "waitlists_seated_booking_id_bookings_id_fk" FOREIGN KEY ("seated_booking_id") REFERENCES "public"."bookings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "waitlists_venue_idx" ON "waitlists" USING btree ("venue_id");--> statement-breakpoint
CREATE INDEX "waitlists_org_idx" ON "waitlists" USING btree ("organisation_id");--> statement-breakpoint
CREATE INDEX "waitlists_venue_active_idx" ON "waitlists" USING btree ("venue_id","requested_at") WHERE "waitlists"."status" = 'waiting';--> statement-breakpoint

-- --- Value constraints -------------------------------------------------------
ALTER TABLE "waitlists"
  ADD CONSTRAINT "waitlists_status_check"
  CHECK (status IN ('waiting', 'seated', 'left', 'cancelled'));--> statement-breakpoint
ALTER TABLE "waitlists"
  ADD CONSTRAINT "waitlists_party_size_check"
  CHECK (party_size >= 1 AND party_size <= 50);--> statement-breakpoint

-- Widen bookings.source to admit 'walk-in' (seated-from-waitlist
-- bookings). Drop + re-add — Postgres can't ALTER an existing CHECK
-- in place. Forward-only since the new domain is a strict superset.
ALTER TABLE "bookings" DROP CONSTRAINT "bookings_source_check";--> statement-breakpoint
ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_source_check"
  CHECK ("source" IN ('host', 'widget', 'rwg', 'api', 'walk-in'));--> statement-breakpoint

-- --- Denormalisation trigger -------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_waitlists_org_id()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
BEGIN
  SELECT organisation_id INTO NEW.organisation_id
  FROM public.venues WHERE id = NEW.venue_id;
  IF NEW.organisation_id IS NULL THEN
    RAISE EXCEPTION 'enforce_waitlists_org_id: parent venue % not found', NEW.venue_id;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER enforce_waitlists_org_id
  BEFORE INSERT OR UPDATE OF venue_id ON public.waitlists
  FOR EACH ROW EXECUTE FUNCTION public.enforce_waitlists_org_id();
--> statement-breakpoint

-- --- updated_at touch trigger ------------------------------------------------
CREATE OR REPLACE FUNCTION public.touch_waitlists_updated_at()
  RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER touch_waitlists_updated_at
  BEFORE UPDATE ON public.waitlists
  FOR EACH ROW EXECUTE FUNCTION public.touch_waitlists_updated_at();
--> statement-breakpoint

-- --- Row Level Security ------------------------------------------------------
ALTER TABLE "waitlists" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- Members of an organisation can read their venue's waitlist. Writes
-- go through server actions backed by adminDb(). No INSERT / UPDATE /
-- DELETE policies for the authenticated role.
CREATE POLICY "waitlists_member_read" ON "waitlists"
  FOR SELECT TO authenticated
  USING (organisation_id IN (SELECT public.user_organisation_ids()));
