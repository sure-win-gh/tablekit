CREATE TABLE "table_combinations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"venue_id" uuid NOT NULL,
	"area_id" uuid NOT NULL,
	"table_a_id" uuid NOT NULL,
	"table_b_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "table_combinations" ADD CONSTRAINT "table_combinations_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_combinations" ADD CONSTRAINT "table_combinations_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_combinations" ADD CONSTRAINT "table_combinations_area_id_areas_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."areas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_combinations" ADD CONSTRAINT "table_combinations_table_a_id_tables_id_fk" FOREIGN KEY ("table_a_id") REFERENCES "public"."tables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_combinations" ADD CONSTRAINT "table_combinations_table_b_id_tables_id_fk" FOREIGN KEY ("table_b_id") REFERENCES "public"."tables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "table_combinations_pair_uq" ON "table_combinations" USING btree ("table_a_id","table_b_id");--> statement-breakpoint
CREATE INDEX "table_combinations_a_idx" ON "table_combinations" USING btree ("table_a_id");--> statement-breakpoint
CREATE INDEX "table_combinations_b_idx" ON "table_combinations" USING btree ("table_b_id");--> statement-breakpoint
CREATE INDEX "table_combinations_venue_idx" ON "table_combinations" USING btree ("venue_id");--> statement-breakpoint
CREATE INDEX "table_combinations_org_idx" ON "table_combinations" USING btree ("organisation_id");--> statement-breakpoint
-- Canonical ordering: store each unordered {A,B} pair exactly once and
-- block self-edges (A = A). The unique index above then dedupes pairs.
ALTER TABLE "table_combinations"
  ADD CONSTRAINT "table_combinations_canonical" CHECK ("table_a_id" < "table_b_id");--> statement-breakpoint
-- Denormalise org/venue/area from the endpoint tables and enforce the
-- same-area rule (both tables must live in one area, so a combined
-- booking stays single-area and enforce_booking_tables_denorm keeps
-- holding). Mirrors enforce_booking_tables_denorm's cross-row area
-- assert (mig 0004).
CREATE OR REPLACE FUNCTION public.enforce_table_combinations_denorm()
RETURNS trigger AS $$
DECLARE
  a_org uuid;
  a_venue uuid;
  a_area uuid;
  b_area uuid;
BEGIN
  SELECT organisation_id, venue_id, area_id INTO a_org, a_venue, a_area
  FROM public.tables WHERE id = NEW.table_a_id;
  IF a_area IS NULL THEN
    RAISE EXCEPTION 'enforce_table_combinations_denorm: table % not found', NEW.table_a_id;
  END IF;

  SELECT area_id INTO b_area FROM public.tables WHERE id = NEW.table_b_id;
  IF b_area IS NULL THEN
    RAISE EXCEPTION 'enforce_table_combinations_denorm: table % not found', NEW.table_b_id;
  END IF;

  IF a_area <> b_area THEN
    RAISE EXCEPTION 'enforce_table_combinations_denorm: tables % and % are in different areas (same-area combinable rule)', NEW.table_a_id, NEW.table_b_id;
  END IF;

  NEW.organisation_id := a_org;
  NEW.venue_id := a_venue;
  NEW.area_id := a_area;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER enforce_table_combinations_denorm
  BEFORE INSERT OR UPDATE OF table_a_id, table_b_id ON public.table_combinations
  FOR EACH ROW EXECUTE FUNCTION public.enforce_table_combinations_denorm();--> statement-breakpoint
-- Org members can read their own venue's join edges (the floor-plan
-- setup surface + availability loaders). All writes go through
-- org-guarded server actions via adminDb(), so no INSERT/UPDATE/DELETE
-- policy for the authenticated role. Mirrors the campaign_templates /
-- billing_* member-read posture.
ALTER TABLE "table_combinations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "table_combinations_member_read" ON "table_combinations"
  FOR SELECT TO authenticated
  USING (organisation_id IN (SELECT public.user_organisation_ids()));
