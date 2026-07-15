-- =============================================================================
-- 0057: api_keys — drop member-read policy (release 2 of 2)
-- =============================================================================
--
-- Completes the two-release policy swap started in 0055. The
-- owner-scoped policy (api_keys_owner_read) has been live for a full
-- release; dropping the 0029 member-wide policy now makes owner-only
-- the effective RLS posture — managers and hosts can no longer read
-- api_keys rows, matching the requireRole("owner") app-layer gate.
--
-- Forward-only. MUST NOT ship in the same release as 0055. Numbered
-- 0057 because 0056 is taken by the ai_usage stack that merges before
-- this gated PR; IF EXISTS keeps it idempotent for DBs that applied
-- the earlier 0056-numbered draft of this drop.
-- =============================================================================

DROP POLICY IF EXISTS "api_keys_member_read" ON "api_keys";
