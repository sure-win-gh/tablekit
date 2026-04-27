CREATE TYPE "public"."oauth_provider" AS ENUM('google', 'tripadvisor', 'facebook');--> statement-breakpoint
CREATE TABLE "venue_oauth_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"venue_id" uuid NOT NULL,
	"provider" "oauth_provider" NOT NULL,
	"external_account_id" text,
	"access_token_cipher" text NOT NULL,
	"refresh_token_cipher" text,
	"scopes" text DEFAULT '' NOT NULL,
	"token_expires_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "venue_oauth_connections" ADD CONSTRAINT "venue_oauth_connections_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "venue_oauth_connections" ADD CONSTRAINT "venue_oauth_connections_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "venue_oauth_connections_venue_provider_unique" ON "venue_oauth_connections" USING btree ("venue_id","provider");--> statement-breakpoint
CREATE INDEX "venue_oauth_connections_org_idx" ON "venue_oauth_connections" USING btree ("organisation_id");--> statement-breakpoint

-- --- Denormalisation trigger -------------------------------------------------
-- Copies organisation_id from the parent venue. Matches the
-- enforce_areas_org_id pattern; SECURITY DEFINER so the lookup
-- bypasses the caller's RLS context.
CREATE OR REPLACE FUNCTION public.enforce_venue_oauth_connections_org_id()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
BEGIN
  SELECT organisation_id INTO NEW.organisation_id
  FROM public.venues WHERE id = NEW.venue_id;
  IF NEW.organisation_id IS NULL THEN
    RAISE EXCEPTION 'enforce_venue_oauth_connections_org_id: parent venue % not found', NEW.venue_id;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER enforce_venue_oauth_connections_org_id
  BEFORE INSERT OR UPDATE OF venue_id ON public.venue_oauth_connections
  FOR EACH ROW EXECUTE FUNCTION public.enforce_venue_oauth_connections_org_id();
--> statement-breakpoint

-- --- updated_at touch trigger ------------------------------------------------
CREATE OR REPLACE FUNCTION public.touch_venue_oauth_connections_updated_at()
  RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER touch_venue_oauth_connections_updated_at
  BEFORE UPDATE ON public.venue_oauth_connections
  FOR EACH ROW EXECUTE FUNCTION public.touch_venue_oauth_connections_updated_at();
--> statement-breakpoint

-- --- Row Level Security ------------------------------------------------------
-- Per-venue scoping (matches reviews_member_read in 0014). Authenticated
-- members can SELECT to read connection state for the venues they can
-- see; all writes go through adminDb() in OAuth handlers + server
-- actions, which is why there are no INSERT/UPDATE/DELETE policies.
ALTER TABLE "venue_oauth_connections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "venue_oauth_connections_member_read" ON "venue_oauth_connections"
  FOR SELECT TO authenticated
  USING (venue_id IN (SELECT public.user_visible_venue_ids()));