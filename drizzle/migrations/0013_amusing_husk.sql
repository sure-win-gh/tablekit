-- =============================================================================
-- 0013: per-venue staff scoping
-- =============================================================================
--
-- Adds memberships.venue_ids (uuid[]) plus a user_visible_venue_ids()
-- SQL helper. NULL venue_ids = "all venues in this org" (legacy
-- behaviour). A non-NULL array restricts the member's RLS-visible
-- scope to those venues.
--
-- Policies updated to use the helper on the high-value tables:
--   - venues, bookings, booking_tables, booking_events, waitlists.
--
-- Out of scope this migration:
--   - payments, messages, dsar_requests stay org-scoped. They have
--     no venue_id column today; tightening them needs a denorm
--     trigger pass that we'll do in a follow-up.
--   - config tables (areas, services, deposit_rules, tables) stay
--     org-scoped. A host can still see the config of every venue in
--     the org; restricting that is a UX-not-security concern.
--
-- Forward-only. Existing memberships keep venue_ids = NULL so RLS
-- behaviour is unchanged for them.
-- =============================================================================

-- --- Drizzle-generated schema (DO NOT HAND-EDIT this block) ------------------
ALTER TABLE "memberships" ADD COLUMN "venue_ids" uuid[];--> statement-breakpoint

-- --- RLS helper --------------------------------------------------------------
-- Returns the set of venue ids the current authed user can see. Joins
-- memberships → venues so the array-membership check happens once
-- and SELECT policies on downstream tables become a simple
-- `venue_id IN (SELECT user_visible_venue_ids())`. SECURITY DEFINER so
-- the join doesn't itself trigger RLS recursion.
CREATE OR REPLACE FUNCTION public.user_visible_venue_ids()
  RETURNS SETOF uuid
  LANGUAGE sql
  SECURITY DEFINER
  STABLE
  SET search_path = public
AS $$
  SELECT v.id
  FROM public.venues v
  JOIN public.memberships m
    ON m.organisation_id = v.organisation_id
   AND m.user_id = auth.uid()
   AND (m.venue_ids IS NULL OR v.id = ANY(m.venue_ids));
$$;
--> statement-breakpoint

-- --- Updated SELECT policies -------------------------------------------------
-- venues: drop the org-scoped read, replace with venue-scoped via the
-- helper. A member with venue_ids=[A] only sees venue A.
DROP POLICY IF EXISTS "venues_member_read" ON "venues";--> statement-breakpoint
CREATE POLICY "venues_member_read" ON "venues"
  FOR SELECT TO authenticated
  USING (id IN (SELECT public.user_visible_venue_ids()));
--> statement-breakpoint

-- bookings: replace the org-scoped read with the venue-scoped check.
DROP POLICY IF EXISTS "bookings_member_read" ON "bookings";--> statement-breakpoint
CREATE POLICY "bookings_member_read" ON "bookings"
  FOR SELECT TO authenticated
  USING (venue_id IN (SELECT public.user_visible_venue_ids()));
--> statement-breakpoint

-- booking_tables: ditto.
DROP POLICY IF EXISTS "booking_tables_member_read" ON "booking_tables";--> statement-breakpoint
CREATE POLICY "booking_tables_member_read" ON "booking_tables"
  FOR SELECT TO authenticated
  USING (venue_id IN (SELECT public.user_visible_venue_ids()));
--> statement-breakpoint

-- booking_events: no venue_id column, but we can route through the
-- parent booking. The subquery is fine perf-wise — booking_events is
-- not a hot read path.
DROP POLICY IF EXISTS "booking_events_member_read" ON "booking_events";--> statement-breakpoint
CREATE POLICY "booking_events_member_read" ON "booking_events"
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.bookings b
      WHERE b.id = booking_events.booking_id
        AND b.venue_id IN (SELECT public.user_visible_venue_ids())
    )
  );
--> statement-breakpoint

-- waitlists: has venue_id directly.
DROP POLICY IF EXISTS "waitlists_member_read" ON "waitlists";--> statement-breakpoint
CREATE POLICY "waitlists_member_read" ON "waitlists"
  FOR SELECT TO authenticated
  USING (venue_id IN (SELECT public.user_visible_venue_ids()));
