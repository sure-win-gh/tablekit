-- =============================================================================
-- 0003: guests-minimal — the one table bookings needs
-- =============================================================================
--
-- Org-scoped (no parent venue), so no denormalisation trigger. The
-- member_read RLS policy is identical to every other tenant table.
-- Writes go through server actions backed by adminDb() — there are
-- intentionally no insert / update / delete policies for authenticated.
-- =============================================================================

-- --- Drizzle-generated schema (DO NOT HAND-EDIT this block) ------------------
CREATE TABLE "guests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"first_name" text NOT NULL,
	"last_name_cipher" text NOT NULL,
	"email_cipher" text NOT NULL,
	"email_hash" text NOT NULL,
	"phone_cipher" text,
	"marketing_consent_at" timestamp with time zone,
	"erased_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "guests" ADD CONSTRAINT "guests_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "guests_org_email_hash_unique" ON "guests" USING btree ("organisation_id","email_hash") WHERE "guests"."erased_at" is null;--> statement-breakpoint
CREATE INDEX "guests_org_idx" ON "guests" USING btree ("organisation_id");--> statement-breakpoint

-- --- updated_at touch trigger -----------------------------------------------
CREATE OR REPLACE FUNCTION public.touch_guests_updated_at()
  RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER touch_guests_updated_at
  BEFORE UPDATE ON public.guests
  FOR EACH ROW EXECUTE FUNCTION public.touch_guests_updated_at();
--> statement-breakpoint

-- --- Row Level Security ------------------------------------------------------
ALTER TABLE "guests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "guests_member_read" ON "guests"
  FOR SELECT TO authenticated
  USING (organisation_id IN (SELECT public.user_organisation_ids()));