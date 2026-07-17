CREATE TABLE "special_event_areas" (
	"event_id" uuid NOT NULL,
	"area_id" uuid NOT NULL,
	"organisation_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "special_event_areas_event_id_area_id_pk" PRIMARY KEY("event_id","area_id")
);
--> statement-breakpoint
ALTER TABLE "special_event_areas" ADD CONSTRAINT "special_event_areas_event_id_special_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."special_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- NO ACTION on area_id is deliberate: deleting a scoped area must fail rather
-- than silently widen the event's block to the whole venue (spec §Area-scoped
-- events).
ALTER TABLE "special_event_areas" ADD CONSTRAINT "special_event_areas_area_id_areas_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."areas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "special_event_areas" ADD CONSTRAINT "special_event_areas_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "special_event_areas_area_idx" ON "special_event_areas" USING btree ("area_id");--> statement-breakpoint
CREATE INDEX "special_event_areas_org_idx" ON "special_event_areas" USING btree ("organisation_id");--> statement-breakpoint
-- RLS: member-read; writes via org-guarded server actions through adminDb()
-- only. Mirrors special_events (migration 0059).
ALTER TABLE "special_event_areas" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "special_event_areas_member_read" ON "special_event_areas"
  FOR SELECT TO authenticated
  USING (organisation_id IN (SELECT public.user_organisation_ids()));
