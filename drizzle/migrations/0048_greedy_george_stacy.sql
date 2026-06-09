CREATE TABLE "venue_photos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"venue_id" uuid NOT NULL,
	"storage_path" text NOT NULL,
	"caption" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "venue_photos" ADD CONSTRAINT "venue_photos_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "venue_photos" ADD CONSTRAINT "venue_photos_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "venue_photos_storage_path_unique" ON "venue_photos" USING btree ("storage_path");--> statement-breakpoint
CREATE INDEX "venue_photos_org_idx" ON "venue_photos" USING btree ("organisation_id");--> statement-breakpoint
CREATE INDEX "venue_photos_venue_sort_idx" ON "venue_photos" USING btree ("venue_id","sort_order");--> statement-breakpoint

-- --- Denormalisation trigger: sync organisation_id from parent venue ---------
-- The client never sets organisation_id directly — it's derived from the
-- parent venue so a crafted payload can't plant a row under another org.
CREATE OR REPLACE FUNCTION public.enforce_venue_photos_org_id()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
BEGIN
  SELECT organisation_id INTO NEW.organisation_id
  FROM public.venues WHERE id = NEW.venue_id;
  IF NEW.organisation_id IS NULL THEN
    RAISE EXCEPTION 'enforce_venue_photos_org_id: parent venue % not found', NEW.venue_id;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER enforce_venue_photos_org_id
  BEFORE INSERT OR UPDATE OF venue_id ON public.venue_photos
  FOR EACH ROW EXECUTE FUNCTION public.enforce_venue_photos_org_id();--> statement-breakpoint

-- --- Row Level Security ------------------------------------------------------
ALTER TABLE "venue_photos" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- Members of an organisation can read their venues' photos. All writes go
-- through the dashboard action via adminDb() (org-guarded by requireRole), so
-- no INSERT/UPDATE/DELETE policy for the authenticated role. Mirrors the
-- message_templates / campaigns posture.
CREATE POLICY "venue_photos_member_read" ON "venue_photos"
  FOR SELECT TO authenticated
  USING (organisation_id IN (SELECT public.user_organisation_ids()));