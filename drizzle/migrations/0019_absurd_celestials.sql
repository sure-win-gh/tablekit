ALTER TABLE "reviews" ADD COLUMN "showcase_consent_at" timestamp with time zone;--> statement-breakpoint

-- --- Showcase candidate index -----------------------------------------------
-- Partial index drives the public booking-widget query: top N
-- internal reviews where the guest opted in and a comment exists. The
-- predicate matches the showcase-eligible row shape exactly so the
-- index is small and the query is a tight range scan.
CREATE INDEX "reviews_showcase_idx"
  ON "reviews" ("venue_id", "submitted_at" DESC)
  WHERE "source" = 'internal'
    AND "showcase_consent_at" IS NOT NULL
    AND "comment_cipher" IS NOT NULL
    AND "rating" >= 4;