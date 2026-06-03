ALTER TABLE "campaigns" ADD COLUMN "segment" text DEFAULT 'all' NOT NULL;--> statement-breakpoint
ALTER TABLE "campaigns"
  ADD CONSTRAINT "campaigns_segment_check"
  CHECK (segment IN ('all', 'new', 'regular', 'lapsed', 'vip'));