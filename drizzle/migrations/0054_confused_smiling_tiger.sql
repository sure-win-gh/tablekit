-- Multi-region Phase 2 (docs/specs/multi-region.md): stripe_events becomes
-- entity-aware. evt_* ids are only unique PER STRIPE ACCOUNT, so with two
-- accounts (uk + us) the dedup key must be (entity, id). Default 'uk'
-- backfills every existing row — all were delivered by the UK account.
--
-- NOTE: hand-ordered. drizzle-kit emitted the ADD CONSTRAINT before the
-- ADD COLUMN and could not name the old PK ("stripe_events_pkey" is the
-- Postgres default for a column-level PRIMARY KEY on this table).
ALTER TABLE "stripe_events" ADD COLUMN "entity" text DEFAULT 'uk' NOT NULL;--> statement-breakpoint
ALTER TABLE "stripe_events" ADD CONSTRAINT "stripe_events_entity_check" CHECK ("entity" IN ('uk', 'us'));--> statement-breakpoint
ALTER TABLE "stripe_events" DROP CONSTRAINT "stripe_events_pkey";--> statement-breakpoint
ALTER TABLE "stripe_events" ADD CONSTRAINT "stripe_events_entity_id_pk" PRIMARY KEY("entity","id");
--> statement-breakpoint
-- TRANSITIONAL (drop in the Phase-4 migration when the US account goes
-- live): the previous deployment's storeEvent uses ON CONFLICT ("id"),
-- which needs a unique constraint on id alone. Without this, every
-- webhook insert from still-running old code errors between the
-- build-step migration and deployment promotion (and instant rollback
-- would break webhooks entirely). Valid while a single Stripe account
-- delivers events; Phase 4 must drop it before the second account sends.
ALTER TABLE "stripe_events" ADD CONSTRAINT "stripe_events_id_key" UNIQUE ("id");
