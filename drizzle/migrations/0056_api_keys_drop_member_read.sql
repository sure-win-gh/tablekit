-- =============================================================================
-- 0056: api_keys — drop member-read policy (release 2 of 2)
-- =============================================================================
--
-- Completes the two-release policy swap started in 0055. The
-- owner-scoped policy (api_keys_owner_read) has been live for a full
-- release; dropping the 0029 member-wide policy now makes owner-only
-- the effective RLS posture — managers and hosts can no longer read
-- api_keys rows, matching the requireRole("owner") app-layer gate.
--
-- Forward-only. MUST NOT ship in the same release as 0055.
-- =============================================================================

DROP POLICY "api_keys_member_read" ON "api_keys";
