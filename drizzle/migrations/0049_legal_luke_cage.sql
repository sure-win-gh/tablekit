CREATE TYPE "public"."pos_provider" AS ENUM('square', 'lightspeed_k', 'generic');--> statement-breakpoint
CREATE TABLE "guest_spend_summary" (
	"guest_id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"order_count" integer DEFAULT 0 NOT NULL,
	"total_spend_minor" bigint DEFAULT 0 NOT NULL,
	"avg_spend_minor" integer DEFAULT 0 NOT NULL,
	"last_order_at" timestamp with time zone,
	"first_order_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pos_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"venue_id" uuid NOT NULL,
	"provider" "pos_provider" NOT NULL,
	"external_account_id" text,
	"access_token_cipher" text,
	"refresh_token_cipher" text,
	"token_expires_at" timestamp with time zone,
	"webhook_secret_cipher" text,
	"line_items_enabled" boolean DEFAULT false NOT NULL,
	"art9_basis_confirmed_at" timestamp with time zone,
	"status" text DEFAULT 'active' NOT NULL,
	"last_synced_at" timestamp with time zone,
	"last_error" text,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pos_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"venue_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"provider" "pos_provider" NOT NULL,
	"external_order_id" text NOT NULL,
	"guest_id" uuid,
	"booking_id" uuid,
	"total_minor" integer NOT NULL,
	"tip_minor" integer DEFAULT 0 NOT NULL,
	"tax_minor" integer,
	"currency" char(3) DEFAULT 'GBP' NOT NULL,
	"cover_count" integer,
	"payment_method_label" text,
	"line_items_cipher" text,
	"closed_at" timestamp with time zone NOT NULL,
	"match_method" text,
	"raw_provider_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pos_webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"provider" "pos_provider" NOT NULL,
	"external_event_id" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "pos_retention_months" integer;--> statement-breakpoint
ALTER TABLE "guest_spend_summary" ADD CONSTRAINT "guest_spend_summary_guest_id_guests_id_fk" FOREIGN KEY ("guest_id") REFERENCES "public"."guests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_spend_summary" ADD CONSTRAINT "guest_spend_summary_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_connections" ADD CONSTRAINT "pos_connections_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_connections" ADD CONSTRAINT "pos_connections_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_connections" ADD CONSTRAINT "pos_connections_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_orders" ADD CONSTRAINT "pos_orders_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_orders" ADD CONSTRAINT "pos_orders_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_orders" ADD CONSTRAINT "pos_orders_connection_id_pos_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."pos_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_orders" ADD CONSTRAINT "pos_orders_guest_id_guests_id_fk" FOREIGN KEY ("guest_id") REFERENCES "public"."guests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_orders" ADD CONSTRAINT "pos_orders_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_webhook_events" ADD CONSTRAINT "pos_webhook_events_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_webhook_events" ADD CONSTRAINT "pos_webhook_events_connection_id_pos_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."pos_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "guest_spend_summary_org_total_idx" ON "guest_spend_summary" USING btree ("organisation_id","total_spend_minor" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "pos_connections_venue_provider_unique" ON "pos_connections" USING btree ("venue_id","provider");--> statement-breakpoint
CREATE INDEX "pos_connections_org_idx" ON "pos_connections" USING btree ("organisation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pos_orders_connection_external_unique" ON "pos_orders" USING btree ("connection_id","external_order_id");--> statement-breakpoint
CREATE INDEX "pos_orders_org_venue_closed_idx" ON "pos_orders" USING btree ("organisation_id","venue_id","closed_at");--> statement-breakpoint
CREATE INDEX "pos_orders_guest_idx" ON "pos_orders" USING btree ("guest_id") WHERE "pos_orders"."guest_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "pos_webhook_events_provider_event_unique" ON "pos_webhook_events" USING btree ("provider","external_event_id");--> statement-breakpoint
CREATE INDEX "pos_webhook_events_org_idx" ON "pos_webhook_events" USING btree ("organisation_id");--> statement-breakpoint
CREATE INDEX "pos_webhook_events_connection_idx" ON "pos_webhook_events" USING btree ("connection_id");--> statement-breakpoint

-- ===========================================================================
-- POS integrations — CHECK constraints, org-id triggers, RLS, Realtime
-- (hand-edited; Drizzle can't express these). Mirrors 0048_* (venue_photos).
-- ===========================================================================

-- --- Value constraints ------------------------------------------------------
ALTER TABLE "pos_connections" ADD CONSTRAINT "pos_connections_status_check"
  CHECK (status IN ('active','paused','revoked','error'));--> statement-breakpoint
ALTER TABLE "pos_orders" ADD CONSTRAINT "pos_orders_match_method_check"
  CHECK (match_method IS NULL OR match_method IN ('email_hash','phone_hash','booking','manual'));--> statement-breakpoint

-- --- Denormalisation triggers: sync organisation_id from the parent ---------
-- The client never sets organisation_id directly — it's derived from the
-- parent row so a crafted payload can't plant a row under another org.

CREATE OR REPLACE FUNCTION public.enforce_pos_connections_org_id()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  SELECT organisation_id INTO NEW.organisation_id
  FROM public.venues WHERE id = NEW.venue_id;
  IF NEW.organisation_id IS NULL THEN
    RAISE EXCEPTION 'enforce_pos_connections_org_id: parent venue % not found', NEW.venue_id;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER enforce_pos_connections_org_id
  BEFORE INSERT OR UPDATE OF venue_id ON public.pos_connections
  FOR EACH ROW EXECUTE FUNCTION public.enforce_pos_connections_org_id();--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.enforce_pos_orders_org_id()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  SELECT organisation_id INTO NEW.organisation_id
  FROM public.venues WHERE id = NEW.venue_id;
  IF NEW.organisation_id IS NULL THEN
    RAISE EXCEPTION 'enforce_pos_orders_org_id: parent venue % not found', NEW.venue_id;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER enforce_pos_orders_org_id
  BEFORE INSERT OR UPDATE OF venue_id ON public.pos_orders
  FOR EACH ROW EXECUTE FUNCTION public.enforce_pos_orders_org_id();--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.enforce_pos_webhook_events_org_id()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  SELECT organisation_id INTO NEW.organisation_id
  FROM public.pos_connections WHERE id = NEW.connection_id;
  IF NEW.organisation_id IS NULL THEN
    RAISE EXCEPTION 'enforce_pos_webhook_events_org_id: parent connection % not found', NEW.connection_id;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER enforce_pos_webhook_events_org_id
  BEFORE INSERT OR UPDATE OF connection_id ON public.pos_webhook_events
  FOR EACH ROW EXECUTE FUNCTION public.enforce_pos_webhook_events_org_id();--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.enforce_guest_spend_summary_org_id()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  SELECT organisation_id INTO NEW.organisation_id
  FROM public.guests WHERE id = NEW.guest_id;
  IF NEW.organisation_id IS NULL THEN
    RAISE EXCEPTION 'enforce_guest_spend_summary_org_id: parent guest % not found', NEW.guest_id;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER enforce_guest_spend_summary_org_id
  BEFORE INSERT OR UPDATE OF guest_id ON public.guest_spend_summary
  FOR EACH ROW EXECUTE FUNCTION public.enforce_guest_spend_summary_org_id();--> statement-breakpoint

-- --- Row Level Security ------------------------------------------------------
-- Members read their org's rows. There is NO authenticated INSERT/UPDATE/
-- DELETE policy: every write goes through adminDb() from a signature-verified
-- webhook handler or cron (deny-by-default). Mirrors the venue_photos posture.
--
-- Scope choice (matches the established precedent, not the generic template):
--   * pos_connections / pos_orders carry venue_id and are venue-located, so
--     they use the VENUE-aware predicate user_visible_venue_ids() — a member
--     scoped to venue A (memberships.venue_ids) can't read venue B's orders
--     within the same org. Same predicate as bookings / venues / waitlists.
--   * pos_webhook_events is an internal idempotency ledger (no venue_id) and
--     guest_spend_summary is per-guest and cross-venue under group CRM (no
--     venue_id; mirrors the org-level RLS on `guests`). Both stay org-level.
ALTER TABLE "pos_connections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pos_webhook_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pos_orders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "guest_spend_summary" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "pos_connections_member_read" ON "pos_connections"
  FOR SELECT TO authenticated
  USING (venue_id IN (SELECT public.user_visible_venue_ids()));--> statement-breakpoint
CREATE POLICY "pos_orders_member_read" ON "pos_orders"
  FOR SELECT TO authenticated
  USING (venue_id IN (SELECT public.user_visible_venue_ids()));--> statement-breakpoint
CREATE POLICY "pos_webhook_events_member_read" ON "pos_webhook_events"
  FOR SELECT TO authenticated
  USING (organisation_id IN (SELECT public.user_organisation_ids()));--> statement-breakpoint
CREATE POLICY "guest_spend_summary_member_read" ON "guest_spend_summary"
  FOR SELECT TO authenticated
  USING (organisation_id IN (SELECT public.user_organisation_ids()));--> statement-breakpoint

-- --- Supabase Realtime -------------------------------------------------------
-- The dashboard subscribes to guest_spend_summary changes (Commit 7). RLS
-- above protects the stream — a client only receives its own org's changes.
-- Guarded so a non-Supabase Postgres (without the default publication) still
-- migrates cleanly.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.guest_spend_summary;
  END IF;
END;
$$;