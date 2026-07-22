-- THROWAWAY: exists only to prove the CI migration-safety gate fires.
-- Do not merge. Every statement below is deliberately unsafe.

ALTER TABLE "bookings" DROP COLUMN "legacy_note";--> statement-breakpoint
ALTER TABLE "bookings" ALTER COLUMN "guest_email" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "guests" ADD COLUMN "loyalty_tier" text NOT NULL;
