CREATE TABLE "event_ticket_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"name" text NOT NULL,
	"price_minor" integer NOT NULL,
	"quantity_total" integer NOT NULL,
	"quantity_sold" integer DEFAULT 0 NOT NULL,
	"max_per_order" integer DEFAULT 10 NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_ticket_types_price_nonneg_check" CHECK ("price_minor" >= 0),
	CONSTRAINT "event_ticket_types_qty_total_pos_check" CHECK ("quantity_total" > 0),
	CONSTRAINT "event_ticket_types_qty_sold_check" CHECK ("quantity_sold" >= 0 AND "quantity_sold" <= "quantity_total"),
	CONSTRAINT "event_ticket_types_max_per_order_pos_check" CHECK ("max_per_order" > 0)
);
--> statement-breakpoint
CREATE TABLE "event_order_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"booking_id" uuid NOT NULL,
	"ticket_type_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"unit_price_minor" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_order_items_quantity_pos_check" CHECK ("quantity" > 0),
	CONSTRAINT "event_order_items_unit_price_nonneg_check" CHECK ("unit_price_minor" >= 0)
);
--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "event_id" uuid;--> statement-breakpoint
ALTER TABLE "bookings" ALTER COLUMN "service_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ALTER COLUMN "area_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "event_ticket_types" ADD CONSTRAINT "event_ticket_types_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_ticket_types" ADD CONSTRAINT "event_ticket_types_event_id_special_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."special_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_order_items" ADD CONSTRAINT "event_order_items_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_order_items" ADD CONSTRAINT "event_order_items_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_order_items" ADD CONSTRAINT "event_order_items_ticket_type_id_event_ticket_types_id_fk" FOREIGN KEY ("ticket_type_id") REFERENCES "public"."event_ticket_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_event_id_special_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."special_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "event_ticket_types_event_idx" ON "event_ticket_types" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "event_ticket_types_org_idx" ON "event_ticket_types" USING btree ("organisation_id");--> statement-breakpoint
CREATE INDEX "event_order_items_booking_idx" ON "event_order_items" USING btree ("booking_id");--> statement-breakpoint
CREATE INDEX "event_order_items_org_idx" ON "event_order_items" USING btree ("organisation_id");--> statement-breakpoint
CREATE INDEX "event_order_items_ticket_type_idx" ON "event_order_items" USING btree ("ticket_type_id");--> statement-breakpoint
CREATE INDEX "bookings_event_idx" ON "bookings" USING btree ("event_id") WHERE "event_id" IS NOT NULL;--> statement-breakpoint
-- Standard vs event bookings can't be malformed. NOT VALID first so the ADD
-- doesn't take a long ACCESS EXCLUSIVE scan on the hot bookings table; VALIDATE
-- then checks existing rows under a weaker lock (all existing rows are standard
-- bookings, so they pass).
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_event_or_service_check" CHECK (
  ("event_id" IS NOT NULL AND "service_id" IS NULL AND "area_id" IS NULL)
  OR ("event_id" IS NULL AND "service_id" IS NOT NULL AND "area_id" IS NOT NULL)
) NOT VALID;--> statement-breakpoint
ALTER TABLE "bookings" VALIDATE CONSTRAINT "bookings_event_or_service_check";--> statement-breakpoint
-- Extend payments.kind for event-ticket PaymentIntents (was migration 0008).
ALTER TABLE "payments" DROP CONSTRAINT "payments_kind_check";--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_kind_check" CHECK (kind IN ('deposit', 'hold', 'no_show_capture', 'refund', 'event_ticket'));--> statement-breakpoint
-- RLS: org members read their own event ticket types + order items; all writes
-- go through org-guarded server actions / the purchase endpoint via adminDb(),
-- so no INSERT/UPDATE/DELETE policy for authenticated. Mirrors the
-- special_events / table_combinations member-read posture.
ALTER TABLE "event_ticket_types" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "event_ticket_types_member_read" ON "event_ticket_types"
  FOR SELECT TO authenticated
  USING (organisation_id IN (SELECT public.user_organisation_ids()));--> statement-breakpoint
ALTER TABLE "event_order_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "event_order_items_member_read" ON "event_order_items"
  FOR SELECT TO authenticated
  USING (organisation_id IN (SELECT public.user_organisation_ids()));
