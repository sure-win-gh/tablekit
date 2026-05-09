-- =============================================================================
-- 0033: webhook_deliveries member-read RLS (PR6c of public-api)
-- =============================================================================
--
-- PR6b's migration shipped a deny-all policy on webhook_deliveries
-- because the dashboard log + replay UI didn't exist yet. PR6c
-- adds the operator-facing log, so members of an organisation now
-- need SELECT access to their own org's delivery rows.
--
-- Writes (dispatcher INSERT, deliver UPDATE, replay INSERT) continue
-- to flow via adminDb — RLS denies all non-SELECT for authenticated
-- by default, so no explicit policy is needed for those.
--
-- Forward-only: drop the deny-all + add the read policy in a single
-- migration. The replacement is logically additive (read access is
-- new), but Postgres requires DROP POLICY before re-creating with
-- a different shape.
-- =============================================================================

DROP POLICY "webhook_deliveries_no_access" ON "webhook_deliveries";--> statement-breakpoint

CREATE POLICY "webhook_deliveries_member_read" ON "webhook_deliveries"
  FOR SELECT TO authenticated
  USING (organisation_id IN (SELECT public.user_organisation_ids()));
