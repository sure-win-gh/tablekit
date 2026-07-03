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
