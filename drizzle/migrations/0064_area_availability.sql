-- Area availability (docs/specs/area-preferences.md): ad-hoc kill switch +
-- seasonal closed months. Defaults preserve today's behaviour for every
-- existing area.
ALTER TABLE "areas" ADD COLUMN "bookable" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "areas" ADD COLUMN "closed_months" integer[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "areas" ADD CONSTRAINT "areas_closed_months_check"
  CHECK ("closed_months" <@ array[1,2,3,4,5,6,7,8,9,10,11,12]);
