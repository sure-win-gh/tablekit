-- =============================================================================
-- 0030: api_idempotency_keys — write-endpoint dedup (PR4 of public-api)
-- =============================================================================
--
-- Stripe-style Idempotency-Key support for POST/PATCH on /api/v1/*.
--
-- Two-phase claim pattern:
--   1. INSERT (api_key_id, key, response_status=null, response_body=null)
--      ON CONFLICT DO NOTHING. The winner runs the handler.
--   2. Once handler completes, UPDATE the row with the final
--      response_status + response_body.
--   3. A concurrent retry hitting the same (api_key_id, key) sees the
--      claim row. If response_status is non-null → return cached body.
--      If null → 409 in_flight (the original is still running).
--
-- Bucketed per api_key_id so two organisations using the same
-- Idempotency-Key value cannot collide. FK cascade on api_keys means
-- revoking a key wipes its idempotency state too.
--
-- RLS: deny all from authenticated/anon — this is API infrastructure.
-- All access via adminDb. Matches inbound_webhook_events (mig 0027)
-- and platform_audit_log (mig 0020).
--
-- Cleanup: 24h expiry sweep lands in PR7 (request logging + retention).
-- For now rows accumulate, bounded above by the per-key revocation
-- cascade.
--
-- Forward-only, additive.
-- =============================================================================

-- --- Drizzle-generated schema (DO NOT HAND-EDIT this block) ------------------
CREATE TABLE "api_idempotency_keys" (
	"api_key_id" uuid NOT NULL,
	"key" text NOT NULL,
	"response_status" integer,
	"response_body" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_idempotency_keys_api_key_id_key_pk" PRIMARY KEY("api_key_id","key")
);
--> statement-breakpoint
ALTER TABLE "api_idempotency_keys" ADD CONSTRAINT "api_idempotency_keys_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- --- Value constraints -------------------------------------------------------
-- Cap on key length. Stripe allows 255; we go shorter (200) to reduce
-- index page bloat and because no real client needs that much.
ALTER TABLE "api_idempotency_keys"
  ADD CONSTRAINT "api_idempotency_keys_key_length_check"
  CHECK (length(key) BETWEEN 1 AND 200);--> statement-breakpoint
-- response_status, when set, must be a valid HTTP status. Defends
-- against application bugs writing garbage into the cache.
ALTER TABLE "api_idempotency_keys"
  ADD CONSTRAINT "api_idempotency_keys_status_range_check"
  CHECK (response_status IS NULL OR response_status BETWEEN 100 AND 599);--> statement-breakpoint

-- --- Row Level Security ------------------------------------------------------
-- Deny-all from authenticated/anon. All reads/writes go through
-- adminDb in the API wrapper. Matches inbound_webhook_events (mig 0028).
ALTER TABLE "api_idempotency_keys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "api_idempotency_keys_no_access" ON "api_idempotency_keys"
  FOR ALL TO authenticated, anon
  USING (false)
  WITH CHECK (false);

