-- 0063: admit 'event' into bookings_source_check.
--
-- Migration 0060 introduced event-ticket bookings (source='event') but the
-- source CHECK from 0010 was never extended, so the very first real purchase
-- would fail the constraint. Not caught earlier because the oversell test
-- replicates the reservation UPDATE rather than driving createEventBooking
-- end-to-end; surfaced by the rls-special-events ticketing fixtures.
--
-- Forward-only. NOT VALID first so the ADD doesn't take a long ACCESS
-- EXCLUSIVE scan on the hot bookings table (same posture as 0060); VALIDATE
-- then checks existing rows under a weaker lock — all existing rows use the
-- old, narrower value set, so they pass.

ALTER TABLE "bookings" DROP CONSTRAINT "bookings_source_check";--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_source_check" CHECK (
  source IN ('host', 'widget', 'rwg', 'api', 'walk-in', 'event')
) NOT VALID;--> statement-breakpoint
ALTER TABLE "bookings" VALIDATE CONSTRAINT "bookings_source_check";
