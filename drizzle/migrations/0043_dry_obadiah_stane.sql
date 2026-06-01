ALTER TABLE "guests" ADD COLUMN "whatsapp_unsubscribed_venues" uuid[] DEFAULT ARRAY[]::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "guests" ADD COLUMN "whatsapp_invalid" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "guests" ADD COLUMN "marketing_consent_whatsapp_at" timestamp with time zone;--> statement-breakpoint

-- --- Extend messages channel CHECK to allow 'whatsapp' ----------------------
-- Forward-only: widening an enumerated allow-list is safe — every existing
-- row's channel ('email'|'sms') stays valid under the new constraint.
-- Mirrors the template-CHECK extension pattern from migration 0018.
ALTER TABLE "messages" DROP CONSTRAINT IF EXISTS "messages_channel_check";--> statement-breakpoint
ALTER TABLE "messages"
  ADD CONSTRAINT "messages_channel_check"
  CHECK (channel IN ('email', 'sms', 'whatsapp'));