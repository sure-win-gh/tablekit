-- =============================================================================
-- 0001: venues foundation — venues, areas, tables, services
-- =============================================================================
--
-- Drizzle generates the schema block; the denormalised-org trigger
-- functions, RLS enable, and read policies are hand-added below. The
-- denormalisation pattern (every child row carries organisation_id,
-- kept in sync by a BEFORE INSERT/UPDATE trigger) is the template
-- every subsequent tenant-scoped table copies.
-- =============================================================================

-- --- Drizzle-generated schema (DO NOT HAND-EDIT this block) ------------------
CREATE TYPE "public"."venue_type" AS ENUM('cafe', 'restaurant', 'bar_pub');--> statement-breakpoint
CREATE TABLE "areas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"venue_id" uuid NOT NULL,
	"name" text NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "services" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"venue_id" uuid NOT NULL,
	"name" text NOT NULL,
	"schedule" jsonb NOT NULL,
	"turn_minutes" integer DEFAULT 90 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tables" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"venue_id" uuid NOT NULL,
	"area_id" uuid NOT NULL,
	"label" text NOT NULL,
	"min_cover" integer DEFAULT 1 NOT NULL,
	"max_cover" integer NOT NULL,
	"shape" text DEFAULT 'rect' NOT NULL,
	"position" jsonb DEFAULT '{"x":0,"y":0,"w":2,"h":2}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "venues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"name" text NOT NULL,
	"venue_type" "venue_type" NOT NULL,
	"timezone" text DEFAULT 'Europe/London' NOT NULL,
	"locale" text DEFAULT 'en-GB' NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "areas" ADD CONSTRAINT "areas_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "areas" ADD CONSTRAINT "areas_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tables" ADD CONSTRAINT "tables_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tables" ADD CONSTRAINT "tables_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tables" ADD CONSTRAINT "tables_area_id_areas_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."areas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "venues" ADD CONSTRAINT "venues_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "areas_venue_idx" ON "areas" USING btree ("venue_id");--> statement-breakpoint
CREATE INDEX "areas_org_idx" ON "areas" USING btree ("organisation_id");--> statement-breakpoint
CREATE INDEX "services_venue_idx" ON "services" USING btree ("venue_id");--> statement-breakpoint
CREATE INDEX "services_org_idx" ON "services" USING btree ("organisation_id");--> statement-breakpoint
CREATE INDEX "tables_venue_idx" ON "tables" USING btree ("venue_id");--> statement-breakpoint
CREATE INDEX "tables_org_idx" ON "tables" USING btree ("organisation_id");--> statement-breakpoint
CREATE INDEX "tables_area_idx" ON "tables" USING btree ("area_id");--> statement-breakpoint
CREATE INDEX "venues_org_idx" ON "venues" USING btree ("organisation_id");--> statement-breakpoint

-- --- Denormalisation triggers ------------------------------------------------
-- Each child row carries organisation_id (and, for tables, venue_id) as
-- a denormalised column. These BEFORE INSERT/UPDATE triggers copy the
-- value from the parent so application code physically cannot create
-- an org-id mismatch. SECURITY DEFINER so we can read from the parent
-- regardless of the caller's RLS context.

-- areas: organisation_id from venue
CREATE OR REPLACE FUNCTION public.enforce_areas_org_id()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
BEGIN
  SELECT organisation_id INTO NEW.organisation_id
  FROM public.venues WHERE id = NEW.venue_id;
  IF NEW.organisation_id IS NULL THEN
    RAISE EXCEPTION 'enforce_areas_org_id: parent venue % not found', NEW.venue_id;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER enforce_areas_org_id
  BEFORE INSERT OR UPDATE OF venue_id ON public.areas
  FOR EACH ROW EXECUTE FUNCTION public.enforce_areas_org_id();
--> statement-breakpoint

-- tables: organisation_id + venue_id both from area (two-for-one)
CREATE OR REPLACE FUNCTION public.enforce_tables_org_and_venue()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
BEGIN
  SELECT a.organisation_id, a.venue_id
    INTO NEW.organisation_id, NEW.venue_id
  FROM public.areas a WHERE a.id = NEW.area_id;
  IF NEW.organisation_id IS NULL OR NEW.venue_id IS NULL THEN
    RAISE EXCEPTION 'enforce_tables_org_and_venue: parent area % not found', NEW.area_id;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER enforce_tables_org_and_venue
  BEFORE INSERT OR UPDATE OF area_id ON public.tables
  FOR EACH ROW EXECUTE FUNCTION public.enforce_tables_org_and_venue();
--> statement-breakpoint

-- services: organisation_id from venue
CREATE OR REPLACE FUNCTION public.enforce_services_org_id()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
BEGIN
  SELECT organisation_id INTO NEW.organisation_id
  FROM public.venues WHERE id = NEW.venue_id;
  IF NEW.organisation_id IS NULL THEN
    RAISE EXCEPTION 'enforce_services_org_id: parent venue % not found', NEW.venue_id;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER enforce_services_org_id
  BEFORE INSERT OR UPDATE OF venue_id ON public.services
  FOR EACH ROW EXECUTE FUNCTION public.enforce_services_org_id();
--> statement-breakpoint

-- --- Row Level Security ------------------------------------------------------
ALTER TABLE "venues"   ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "areas"    ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tables"   ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "services" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- Members of an organisation can read anything scoped to it. Writes go
-- through server actions backed by adminDb() (which bypasses RLS via
-- the postgres superuser connection); there are intentionally no
-- insert / update / delete policies for the authenticated role.
CREATE POLICY "venues_member_read" ON "venues"
  FOR SELECT TO authenticated
  USING (organisation_id IN (SELECT public.user_organisation_ids()));
--> statement-breakpoint

CREATE POLICY "areas_member_read" ON "areas"
  FOR SELECT TO authenticated
  USING (organisation_id IN (SELECT public.user_organisation_ids()));
--> statement-breakpoint

CREATE POLICY "tables_member_read" ON "tables"
  FOR SELECT TO authenticated
  USING (organisation_id IN (SELECT public.user_organisation_ids()));
--> statement-breakpoint

CREATE POLICY "services_member_read" ON "services"
  FOR SELECT TO authenticated
  USING (organisation_id IN (SELECT public.user_organisation_ids()));
