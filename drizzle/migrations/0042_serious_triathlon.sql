ALTER TABLE "bookings" ADD COLUMN "high_chairs" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "dietary_notes_cipher" text;--> statement-breakpoint
ALTER TABLE "guests" ADD COLUMN "tags" text[] DEFAULT ARRAY[]::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "guests" ADD COLUMN "notes_cipher" text;