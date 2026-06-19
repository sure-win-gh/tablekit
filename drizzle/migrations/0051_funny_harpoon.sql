-- =============================================================================
-- 0051: bookings active-rows read index (security audit P2)
-- =============================================================================
--
-- Partial index on (venue_id, start_at) over non-cancelled bookings — serves
-- the hottest read paths (floor view, availability/overlap checks, heatmap +
-- covers reports) which scan a venue's start_at range excluding cancelled
-- rows. Status is a negation in those queries so it can't be an ordered index
-- column; the partial predicate keeps the index small as cancelled history
-- grows. Forward-only and additive.
--
-- Note: a plain (non-CONCURRENT) CREATE INDEX takes a SHARE lock that blocks
-- writes to bookings for the build duration, matching this repo's
-- transactional migration convention. Fine at current scale; if bookings
-- grows large, rebuild this out-of-band with CREATE INDEX CONCURRENTLY.
-- =============================================================================

CREATE INDEX "bookings_venue_start_active_idx" ON "bookings" USING btree ("venue_id","start_at") WHERE "bookings"."status" <> 'cancelled';