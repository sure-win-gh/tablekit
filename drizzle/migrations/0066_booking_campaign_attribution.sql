ALTER TABLE "bookings" ADD COLUMN "campaign_id" uuid;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "attribution_kind" text;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bookings_campaign_idx" ON "bookings" USING btree ("campaign_id") WHERE "bookings"."campaign_id" is not null;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_attribution_kind_check" CHECK ("bookings"."attribution_kind" is null or "bookings"."attribution_kind" in ('link', 'click_window'));