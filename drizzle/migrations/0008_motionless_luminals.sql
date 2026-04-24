-- =============================================================================
-- 0008: payments-deposits — deposit_rules + payments + guests.stripe_customer_id
-- =============================================================================
--
-- Drizzle generates the schema block; denormalisation triggers, RLS
-- policies, updated_at touch triggers, and CHECK constraints are
-- appended below.
--
-- Forward-only, additive. No backfill required (both tables are empty
-- on arrival; `guests.stripe_customer_id` is nullable).
--
-- RLS pattern matches 0001/0006 — SELECT-only for authenticated via
-- user_organisation_ids(); writes go through adminDb() server actions.
-- No INSERT / UPDATE / DELETE policies for authenticated role.
--
-- Currency is pinned to GBP at the DB level. Multi-currency is out of
-- scope until a dedicated phase; the check is a tripwire for an
-- accidental non-GBP insert.
-- =============================================================================

-- --- Drizzle-generated schema (DO NOT HAND-EDIT this block) ------------------
CREATE TABLE "deposit_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"venue_id" uuid NOT NULL,
	"service_id" uuid,
	"min_party" integer DEFAULT 1 NOT NULL,
	"max_party" integer,
	"day_of_week" integer[] DEFAULT ARRAY[0,1,2,3,4,5,6]::integer[] NOT NULL,
	"kind" text NOT NULL,
	"amount_minor" integer NOT NULL,
	"currency" char(3) DEFAULT 'GBP' NOT NULL,
	"refund_window_hours" integer DEFAULT 24 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"booking_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"stripe_intent_id" text NOT NULL,
	"stripe_customer_id" text,
	"stripe_payment_method_id" text,
	"amount_minor" integer NOT NULL,
	"currency" char(3) NOT NULL,
	"status" text NOT NULL,
	"failure_code" text,
	"failure_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_stripe_intent_id_unique" UNIQUE("stripe_intent_id")
);
--> statement-breakpoint
ALTER TABLE "guests" ADD COLUMN "stripe_customer_id" text;--> statement-breakpoint
ALTER TABLE "deposit_rules" ADD CONSTRAINT "deposit_rules_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposit_rules" ADD CONSTRAINT "deposit_rules_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposit_rules" ADD CONSTRAINT "deposit_rules_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deposit_rules_venue_idx" ON "deposit_rules" USING btree ("venue_id");--> statement-breakpoint
CREATE INDEX "deposit_rules_org_idx" ON "deposit_rules" USING btree ("organisation_id");--> statement-breakpoint
CREATE INDEX "payments_booking_idx" ON "payments" USING btree ("booking_id");--> statement-breakpoint
CREATE INDEX "payments_org_idx" ON "payments" USING btree ("organisation_id");--> statement-breakpoint

-- --- Value constraints -------------------------------------------------------
-- Kind is free-text in Drizzle; CHECK pins the domain so a mutated
-- union in TS can't quietly insert garbage. Amounts: non-refund rows
-- must be >= 0 (Stripe rejects zero-amount Intents separately, but we
-- allow 0 in the table for forward compatibility); refund rows must
-- be <= 0 (money out is negative). Currency: MVP is GBP only.
ALTER TABLE "deposit_rules"
  ADD CONSTRAINT "deposit_rules_kind_check"
  CHECK (kind IN ('per_cover', 'flat', 'card_hold'));--> statement-breakpoint
ALTER TABLE "deposit_rules"
  ADD CONSTRAINT "deposit_rules_amount_nonneg_check"
  CHECK (amount_minor >= 0);--> statement-breakpoint
ALTER TABLE "deposit_rules"
  ADD CONSTRAINT "deposit_rules_currency_gbp_check"
  CHECK (currency = 'GBP');--> statement-breakpoint
ALTER TABLE "deposit_rules"
  ADD CONSTRAINT "deposit_rules_party_range_check"
  CHECK (min_party >= 1 AND (max_party IS NULL OR max_party >= min_party));--> statement-breakpoint

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_kind_check"
  CHECK (kind IN ('deposit', 'hold', 'no_show_capture', 'refund'));--> statement-breakpoint
ALTER TABLE "payments"
  ADD CONSTRAINT "payments_amount_sign_check"
  CHECK (
    (kind = 'refund' AND amount_minor <= 0)
    OR (kind <> 'refund' AND amount_minor >= 0)
  );--> statement-breakpoint
ALTER TABLE "payments"
  ADD CONSTRAINT "payments_currency_gbp_check"
  CHECK (currency = 'GBP');--> statement-breakpoint

-- --- Denormalisation triggers ------------------------------------------------
-- Copy organisation_id from the parent row on INSERT and on updates to
-- the FK column. SECURITY DEFINER so the read from the parent is RLS-
-- independent. Matches the 0001/0004 pattern.

CREATE OR REPLACE FUNCTION public.enforce_deposit_rules_org_id()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
BEGIN
  SELECT organisation_id INTO NEW.organisation_id
  FROM public.venues WHERE id = NEW.venue_id;
  IF NEW.organisation_id IS NULL THEN
    RAISE EXCEPTION 'enforce_deposit_rules_org_id: parent venue % not found', NEW.venue_id;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER enforce_deposit_rules_org_id
  BEFORE INSERT OR UPDATE OF venue_id ON public.deposit_rules
  FOR EACH ROW EXECUTE FUNCTION public.enforce_deposit_rules_org_id();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.enforce_payments_org_id()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
BEGIN
  SELECT organisation_id INTO NEW.organisation_id
  FROM public.bookings WHERE id = NEW.booking_id;
  IF NEW.organisation_id IS NULL THEN
    RAISE EXCEPTION 'enforce_payments_org_id: parent booking % not found', NEW.booking_id;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER enforce_payments_org_id
  BEFORE INSERT OR UPDATE OF booking_id ON public.payments
  FOR EACH ROW EXECUTE FUNCTION public.enforce_payments_org_id();
--> statement-breakpoint

-- --- updated_at touch triggers ----------------------------------------------
CREATE OR REPLACE FUNCTION public.touch_deposit_rules_updated_at()
  RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER touch_deposit_rules_updated_at
  BEFORE UPDATE ON public.deposit_rules
  FOR EACH ROW EXECUTE FUNCTION public.touch_deposit_rules_updated_at();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.touch_payments_updated_at()
  RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER touch_payments_updated_at
  BEFORE UPDATE ON public.payments
  FOR EACH ROW EXECUTE FUNCTION public.touch_payments_updated_at();
--> statement-breakpoint

-- --- Row Level Security ------------------------------------------------------
ALTER TABLE "deposit_rules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payments"      ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- Members of an organisation can read their deposit rules + payment
-- rows. All writes route through server actions backed by adminDb()
-- (postgres superuser, ignores RLS). No INSERT / UPDATE / DELETE
-- policies for the authenticated role.
CREATE POLICY "deposit_rules_member_read" ON "deposit_rules"
  FOR SELECT TO authenticated
  USING (organisation_id IN (SELECT public.user_organisation_ids()));
--> statement-breakpoint

CREATE POLICY "payments_member_read" ON "payments"
  FOR SELECT TO authenticated
  USING (organisation_id IN (SELECT public.user_organisation_ids()));
