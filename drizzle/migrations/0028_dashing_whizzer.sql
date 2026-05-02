-- =============================================================================
-- 0028: inbound_webhook_events — idempotency surface for inbound webhooks
-- =============================================================================
--
-- Generic dedup table for any inbound webhook that emits a unique
-- event id. PR2 of the AI enquiry feature uses it to short-circuit
-- Resend's at-least-once delivery — Svix retries reuse `svix-id`
-- on every attempt, so an INSERT ON CONFLICT DO NOTHING is the
-- dedup primitive.
--
-- Platform-only — no organisation_id, no PII. RLS denies all
-- access for `authenticated` and `anon`; webhook routes use
-- adminDb (BYPASSRLS). Matches the platform_audit_log shape from
-- migration 0020.
--
-- Forward-only, additive.
-- =============================================================================

-- --- Drizzle-generated schema (DO NOT HAND-EDIT this block) ------------------
CREATE TABLE "inbound_webhook_events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- --- Indexes -----------------------------------------------------------------
-- Used by retention sweepers (delete events older than N days).
CREATE INDEX "inbound_webhook_events_received_at_idx"
  ON "inbound_webhook_events" USING btree ("received_at");--> statement-breakpoint

-- --- Row Level Security ------------------------------------------------------
-- Platform-staff-only table. Operators must never read or write
-- this — RLS denies authenticated and anon outright. Writes flow
-- via adminDb() (Postgres BYPASSRLS attribute). The deny-all policy
-- keeps check-rls.ts happy: RLS enabled + at least one policy.
ALTER TABLE "inbound_webhook_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "inbound_webhook_events_no_access" ON "inbound_webhook_events"
  FOR ALL TO authenticated, anon
  USING (false)
  WITH CHECK (false);
