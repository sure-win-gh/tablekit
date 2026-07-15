-- =============================================================================
-- 0055: api_keys — owner-only read policy (release 1 of 2)
-- =============================================================================
--
-- The api_keys feature is owner-only at the app layer (page + server
-- actions gate on requireRole("owner")), but the RLS policy from 0029
-- ("api_keys_member_read") grants SELECT to every org member — a host
-- session querying under withUser can read key metadata (prefix,
-- label, last_used_at). No secret material is exposed (only the
-- SHA-256 hash is stored, and loadApiKeys never selects it), but the
-- DB layer should match the owner-only intent.
--
-- This migration is the ADDITIVE half of a two-release policy swap:
--   Release 1 (here): add user_owner_organisation_ids() + the
--     owner-scoped policy. Policies OR together, so the old
--     member-read policy still wins during this release — deliberate,
--     nothing changes behaviourally until the drop.
--   Release 2 (0056+): DROP POLICY "api_keys_member_read".
--
-- Forward-only, additive.
-- =============================================================================

-- Owner-scoped sibling of user_organisation_ids() (0000). SECURITY
-- DEFINER for the same reason: policies subquerying memberships would
-- otherwise recurse into the memberships policies themselves.
CREATE OR REPLACE FUNCTION public.user_owner_organisation_ids()
  RETURNS SETOF uuid
  LANGUAGE sql
  SECURITY DEFINER
  STABLE
  SET search_path = public
AS $$
  SELECT organisation_id
  FROM public.memberships
  WHERE user_id = auth.uid()
    AND role = 'owner';
$$;
--> statement-breakpoint

CREATE POLICY "api_keys_owner_read" ON "api_keys"
  FOR SELECT TO authenticated
  USING (organisation_id IN (SELECT public.user_owner_organisation_ids()));
--> statement-breakpoint

COMMENT ON POLICY "api_keys_member_read" ON "api_keys" IS
  'DEPRECATED: superseded by api_keys_owner_read (0055). Dropped in the next release per the two-release drop rule.';
