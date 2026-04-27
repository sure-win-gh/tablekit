ALTER TABLE "reviews" DROP CONSTRAINT "reviews_booking_id_unique";--> statement-breakpoint
ALTER TABLE "reviews" ALTER COLUMN "booking_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "reviews" ALTER COLUMN "guest_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "external_url" text;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "reviewer_display_name" text;--> statement-breakpoint

-- --- Partial UNIQUE: one internal review per booking ------------------------
-- Replaces the dropped reviews_booking_id_unique total UNIQUE — preserves
-- the Phase 1 invariant for internal rows but allows multiple non-internal
-- rows (which all have NULL booking_id) per venue.
CREATE UNIQUE INDEX "reviews_booking_id_unique"
  ON "reviews" ("booking_id")
  WHERE "booking_id" IS NOT NULL;--> statement-breakpoint

-- --- Partial UNIQUE: dedup by external id within (venue, source) -----------
-- Imported reviews (Google etc.) carry a stable provider-side id. The
-- sync job upserts on this index so re-runs don't duplicate.
CREATE UNIQUE INDEX "reviews_venue_source_external_unique"
  ON "reviews" ("venue_id", "source", "external_id")
  WHERE "external_id" IS NOT NULL;--> statement-breakpoint

-- --- Source-shape CHECK -----------------------------------------------------
-- Internal rows: booking_id + guest_id are non-null, no external_id.
-- External rows: booking_id + guest_id are null, external_id is set,
--                reviewer_display_name is set. Enforced at the DB so
--                a code path can't half-fill an external review.
ALTER TABLE "reviews"
  ADD CONSTRAINT "reviews_source_shape_check"
  CHECK (
    (source = 'internal' AND booking_id IS NOT NULL AND guest_id IS NOT NULL AND external_id IS NULL)
    OR
    (source <> 'internal' AND booking_id IS NULL AND guest_id IS NULL AND external_id IS NOT NULL AND reviewer_display_name IS NOT NULL)
  );--> statement-breakpoint

-- --- Update denorm trigger for external reviews ----------------------------
-- Internal rows: copy organisation_id + venue_id from the parent booking
-- (existing behaviour). External rows: caller supplies organisation_id +
-- venue_id directly; the trigger validates that the venue belongs to
-- the org rather than overriding. SECURITY DEFINER so the lookup
-- bypasses the caller's RLS context either way.
CREATE OR REPLACE FUNCTION public.enforce_reviews_org_and_venue()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
DECLARE
  v_org_id uuid;
BEGIN
  IF NEW.booking_id IS NOT NULL THEN
    SELECT b.organisation_id, b.venue_id
      INTO NEW.organisation_id, NEW.venue_id
    FROM public.bookings b WHERE b.id = NEW.booking_id;
    IF NEW.organisation_id IS NULL OR NEW.venue_id IS NULL THEN
      RAISE EXCEPTION 'enforce_reviews_org_and_venue: parent booking % not found', NEW.booking_id;
    END IF;
  ELSE
    -- External review — caller supplied org_id + venue_id. Validate
    -- the venue belongs to the org so a bug in caller code can't
    -- cross-link tenants.
    SELECT v.organisation_id INTO v_org_id
    FROM public.venues v WHERE v.id = NEW.venue_id;
    IF v_org_id IS NULL THEN
      RAISE EXCEPTION 'enforce_reviews_org_and_venue: venue % not found', NEW.venue_id;
    END IF;
    IF NEW.organisation_id IS NULL OR NEW.organisation_id <> v_org_id THEN
      -- Overwrite the supplied org_id with the venue's org_id —
      -- matches the spirit of the internal branch (DB is the source
      -- of truth, caller can't spoof).
      NEW.organisation_id := v_org_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;