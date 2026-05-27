-- =============================================================================
-- 0039: outreach_claims + organisations.{claimed_at,outreach_source}
--       — pre-populated accounts for cold outreach
-- =============================================================================
--
-- The founder builds a real `organisations` + `venues` row for a
-- prospect (using public data from Google Places) and emails them a
-- magic link to claim ownership. Until claim, the row's
-- `organisations.claimed_at` is NULL and only the temporary owner
-- (founder) sits in `memberships`. A daily cron purges unclaimed orgs
-- older than 30 days; the claim TTL on `outreach_claims.expires_at`
-- matches.
--
-- Backfill: every pre-existing organisations row is treated as already
-- claimed by stamping `claimed_at = created_at` so the purge cron
-- doesn't sweep them.
--
-- RLS posture on `outreach_claims`:
--   • deny-all to authenticated + anon (no tenant scope on this table)
--   • all writes flow through adminDb() — internal admin UI is
--     platform-admin gated at the route layer, the public /claim/[token]
--     flow re-resolves the token via adminDb() before granting access
--
-- `organisations` already has RLS from migration 0000; the two new
-- columns inherit it. No policy change needed — the existing
-- "members of org X" predicate still applies, and the founder's
-- temporary membership keeps unclaimed orgs visible only to them
-- through normal RLS.
--
-- Forward-only, additive.
-- =============================================================================

-- --- Drizzle-generated schema (DO NOT HAND-EDIT this block) ------------------
CREATE TABLE "outreach_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"prospect_email" "citext" NOT NULL,
	"prospect_name" text,
	"expires_at" timestamp with time zone NOT NULL,
	"claimed_at" timestamp with time zone,
	"claimed_by_user_id" uuid,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outreach_claims_organisation_id_unique" UNIQUE("organisation_id"),
	CONSTRAINT "outreach_claims_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "outreach_source" text;--> statement-breakpoint
ALTER TABLE "outreach_claims" ADD CONSTRAINT "outreach_claims_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_claims" ADD CONSTRAINT "outreach_claims_claimed_by_user_id_users_id_fk" FOREIGN KEY ("claimed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_claims" ADD CONSTRAINT "outreach_claims_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "outreach_claims_created_at_idx" ON "outreach_claims" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "organisations_unclaimed_idx" ON "organisations" USING btree ("created_at") WHERE "organisations"."claimed_at" is null;--> statement-breakpoint

-- --- Backfill organisations.claimed_at ---------------------------------------
-- Every pre-existing org is already "claimed" (it has a real owner who
-- signed up through /signup). Stamp claimed_at = created_at so the
-- purge cron's `WHERE claimed_at IS NULL` filter excludes them.
--
-- Ordering note: this backfill must precede any future migration that
-- tightens claimed_at to NOT NULL. PR 6's purge cron filters on
-- `claimed_at IS NULL`, not on the column being non-null.
UPDATE "organisations" SET "claimed_at" = "created_at" WHERE "claimed_at" IS NULL;--> statement-breakpoint

-- --- Expiry sanity -----------------------------------------------------------
ALTER TABLE "outreach_claims"
  ADD CONSTRAINT "outreach_claims_expiry_check"
  CHECK (expires_at > created_at);--> statement-breakpoint

-- --- RLS: outreach_claims (platform-only, deny-all) --------------------------
-- No tenant column on this table — it's platform-level metadata that
-- the internal admin UI (platform-admin gated) and the public claim
-- flow both touch via adminDb(). RLS denies authenticated + anon
-- outright, which also satisfies check-rls.ts (RLS enabled + ≥1
-- policy).
ALTER TABLE "outreach_claims" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "outreach_claims" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "outreach_claims_no_access" ON "outreach_claims"
  FOR ALL TO authenticated, anon
  USING (false)
  WITH CHECK (false);
