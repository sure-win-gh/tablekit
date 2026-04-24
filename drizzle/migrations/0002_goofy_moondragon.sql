ALTER TABLE "organisations" ADD COLUMN "wrapped_dek" "bytea";--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "dek_version" integer DEFAULT 1 NOT NULL;