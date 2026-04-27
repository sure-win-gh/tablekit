ALTER TABLE "reviews" ADD COLUMN "response_cipher" text;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "responded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "responded_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_responded_by_user_id_users_id_fk" FOREIGN KEY ("responded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- --- Extend messages template CHECK to allow review.operator_reply ----------
-- Forward-only: extending an enumerated allow-list is safe because every
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
    'review.operator_reply'
  ));--> statement-breakpoint

-- --- Sanity: response_cipher is set iff responded_at is set -----------------
ALTER TABLE "reviews"
  ADD CONSTRAINT "reviews_response_consistency_check"
  CHECK ((response_cipher IS NULL) = (responded_at IS NULL));