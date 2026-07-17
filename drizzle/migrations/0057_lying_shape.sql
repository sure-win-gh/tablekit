-- Snapshot reconciliation, not new DDL. The three CHECK constraints below
-- were already applied by hand in migrations 0053 (organisations) and 0054
-- (stripe_events); they were only just declared in schema.ts via drizzle
-- check(), so this generated migration exists to advance the drizzle
-- snapshot to match the live DB. See docs/specs/multi-region.md and the
-- ROADMAP §5 hygiene note.
--
-- Guarded so it's a no-op on every DB that already ran 0053/0054 (all of
-- them, since those run first), while still being self-healing if a
-- constraint were ever missing. Column names are unqualified inside ALTER
-- TABLE ... ADD CONSTRAINT, matching the 0053/0054 definitions exactly.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'organisations_region_check') THEN
    ALTER TABLE "organisations" ADD CONSTRAINT "organisations_region_check" CHECK ("region" IN ('eu', 'us'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'organisations_billing_entity_check') THEN
    ALTER TABLE "organisations" ADD CONSTRAINT "organisations_billing_entity_check" CHECK ("billing_entity" IN ('uk', 'us'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stripe_events_entity_check') THEN
    ALTER TABLE "stripe_events" ADD CONSTRAINT "stripe_events_entity_check" CHECK ("entity" IN ('uk', 'us'));
  END IF;
END $$;
