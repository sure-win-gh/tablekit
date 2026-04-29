ALTER TABLE "guests" ADD COLUMN "marketing_consent_email_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "guests" ADD COLUMN "marketing_consent_sms_at" timestamp with time zone;--> statement-breakpoint
-- Backfill: existing single-channel `marketing_consent_at` was always
-- gathered as an email-channel opt-in (no SMS UI ever existed). Copy
-- it into the new email column. SMS stays null — operators must
-- explicitly opt guests in. The legacy column is retained for one
-- release; the next migration drops it once readers have moved.
UPDATE "guests"
   SET "marketing_consent_email_at" = "marketing_consent_at"
 WHERE "marketing_consent_at" IS NOT NULL;