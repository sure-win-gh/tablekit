-- =============================================================================
-- 0037: reviews.sentiment — Phase 5 AI sentiment classification
-- =============================================================================
--
-- Adds two columns to `reviews`:
--   • sentiment text NULL              — 'positive' | 'neutral' | 'negative'
--   • sentiment_classified_at timestamptz NULL
--
-- Populated by a fire-and-forget Bedrock call after a review is
-- inserted (see lib/reviews/sentiment.ts). Forward-only, additive —
-- nothing reads the column today besides the dashboard list, so a
-- failed classify just leaves a NULL row that future polls / retries
-- can pick up.
--
-- Existing RLS on `reviews` (venue-scoped SELECT, no write policies)
-- covers the new columns by virtue of being table-level. The CHECK
-- below ensures `sentiment` only takes the three-bucket label.
--
-- Partial index supports "find rows still needing classification"
-- without a sequential scan once the table grows — same shape as the
-- enquiries_received_picker_idx pattern.
-- =============================================================================

-- --- Drizzle-generated schema (DO NOT HAND-EDIT this block) ------------------
ALTER TABLE "reviews" ADD COLUMN "sentiment" text;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "sentiment_classified_at" timestamp with time zone;--> statement-breakpoint

-- --- Value constraints -------------------------------------------------------
ALTER TABLE "reviews"
  ADD CONSTRAINT "reviews_sentiment_check"
  CHECK (sentiment IS NULL OR sentiment IN ('positive','neutral','negative'));--> statement-breakpoint

-- --- Picker index ------------------------------------------------------------
-- Backfill candidates: rows with a comment + still NULL sentiment.
-- Reviews without a comment stay NULL forever — we don't classify
-- from rating alone (5★ "loved it" vs 5★ given begrudgingly differ).
CREATE INDEX "reviews_sentiment_picker_idx"
  ON "reviews" ("submitted_at")
  WHERE sentiment IS NULL AND comment_cipher IS NOT NULL;--> statement-breakpoint
