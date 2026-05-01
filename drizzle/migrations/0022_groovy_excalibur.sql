ALTER TABLE "venues" ADD COLUMN "slug" "citext";--> statement-breakpoint
CREATE UNIQUE INDEX "venues_slug_unique" ON "venues" USING btree ("slug") WHERE "venues"."slug" is not null;--> statement-breakpoint
-- Defence-in-depth format check. The Zod validator at the form layer
-- enforces the same shape; this CHECK catches any code path that ever
-- writes the column without going through validateSlug().
ALTER TABLE "venues" ADD CONSTRAINT "venues_slug_format_chk"
  CHECK ("slug" IS NULL OR "slug" ~ '^[a-z0-9](?:[a-z0-9-]{1,58}[a-z0-9])?$');