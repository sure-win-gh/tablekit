CREATE TABLE "service_capacity_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"capacity" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_capacity_overrides_service_id_unique" UNIQUE("service_id")
);
--> statement-breakpoint
ALTER TABLE "service_capacity_overrides" ADD CONSTRAINT "service_capacity_overrides_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_capacity_overrides" ADD CONSTRAINT "service_capacity_overrides_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "service_capacity_overrides_org_idx" ON "service_capacity_overrides" USING btree ("organisation_id");--> statement-breakpoint

-- --- Denormalise organisation_id from the parent service --------------------
-- Mirrors enforce_services_org_id (migration 0001). SECURITY DEFINER so the
-- parent read isn't subject to the caller's RLS context.
CREATE OR REPLACE FUNCTION public.enforce_service_capacity_overrides_org_id()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
BEGIN
  SELECT organisation_id INTO NEW.organisation_id
  FROM public.services WHERE id = NEW.service_id;
  IF NEW.organisation_id IS NULL THEN
    RAISE EXCEPTION 'enforce_service_capacity_overrides_org_id: parent service % not found', NEW.service_id;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER enforce_service_capacity_overrides_org_id
  BEFORE INSERT OR UPDATE OF service_id ON public.service_capacity_overrides
  FOR EACH ROW EXECUTE FUNCTION public.enforce_service_capacity_overrides_org_id();--> statement-breakpoint

-- --- Row Level Security ------------------------------------------------------
-- Org-scoped member-read, same posture as services/areas/tables (migration
-- 0001): members of the owning org can read; writes go through adminDb()
-- which bypasses RLS via the service role. No insert/update/delete policy.
ALTER TABLE "service_capacity_overrides" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "service_capacity_overrides_member_read" ON "service_capacity_overrides"
  FOR SELECT TO authenticated
  USING (organisation_id IN (SELECT public.user_organisation_ids()));