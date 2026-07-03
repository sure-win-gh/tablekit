ALTER TABLE "organisations" ADD COLUMN "region" text DEFAULT 'eu' NOT NULL;--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "billing_entity" text DEFAULT 'uk' NOT NULL;--> statement-breakpoint
ALTER TABLE "organisations" ADD CONSTRAINT "organisations_region_check" CHECK ("region" IN ('eu', 'us'));--> statement-breakpoint
ALTER TABLE "organisations" ADD CONSTRAINT "organisations_billing_entity_check" CHECK ("billing_entity" IN ('uk', 'us'));
