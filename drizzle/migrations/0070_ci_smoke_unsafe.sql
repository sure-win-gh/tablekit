-- THROWAWAY: exists only to prove the CI migration-safety gate fires.
-- Do not merge.
--
-- Phase 2 of the smoke test: the same intent as the unsafe version, but
-- reworked into the expand/contract shape the gate wants — additive,
-- nullable, no table rewrite. Should pass cleanly.
--
-- Deliberately NOT listed in meta/_journal.json, so `pnpm db:migrate` will
-- never apply it to the shared CI database. The safety linter reads the
-- migrations directory directly, so it still sees the file. That keeps this
-- smoke test from leaving schema drift behind in the CI DB.

ALTER TABLE "guests" ADD COLUMN "loyalty_tier" text;
