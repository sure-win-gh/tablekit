ALTER TABLE "reviews" ADD COLUMN "escalation_alert_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "recovery_offer_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "recovery_offered_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "recovery_message_cipher" text;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_recovery_offered_by_user_id_users_id_fk" FOREIGN KEY ("recovery_offered_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- --- Recovery shape consistency CHECK ---------------------------------------
-- Mirrors reviews_response_consistency_check from 0015: cipher and
-- timestamp move together, so a row can never be in a half-claimed
-- state. The conditional UPDATE pattern in the recovery action
-- depends on this — both columns null = "no recovery sent", both
-- set = "recovery sent at T".
ALTER TABLE "reviews"
  ADD CONSTRAINT "reviews_recovery_consistency_check"
  CHECK ((recovery_message_cipher IS NULL) = (recovery_offer_at IS NULL));--> statement-breakpoint

-- --- Extend messages template CHECK to allow review.recovery_offer ----------
-- Forward-only: extending an enumerated allow-list is safe — every
-- existing row's template stays valid under the new constraint.
ALTER TABLE "messages" DROP CONSTRAINT IF EXISTS "messages_template_check";--> statement-breakpoint
ALTER TABLE "messages"
  ADD CONSTRAINT "messages_template_check"
  CHECK (template IN (
    'booking.confirmation',
    'booking.reminder_24h',
    'booking.reminder_2h',
    'booking.cancelled',
    'booking.thank_you',
    'booking.waitlist_ready',
    'booking.review_request',
    'review.operator_reply',
    'review.recovery_offer'
  ));