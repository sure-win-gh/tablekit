-- =============================================================================
-- 0034: api_request_log — operational telemetry (PR7 of public-api)
-- =============================================================================
--
-- One row per authenticated request to /api/v1/*. Captures the
-- minimum fields the spec promises: method, path, organisation,
-- status, latency. NEVER request or response bodies.
--
-- Retention: 90 days, swept by /api/cron/api-request-log-retention.
-- The created_at index supports the sweep's range scan.
--
-- RLS: deny-all from authenticated/anon (admin-only). All access
-- via adminDb. A future operator-facing "API activity log" UI
-- would lift the read side to org members; until then this is
-- internal telemetry.
--
-- FK posture:
--   • organisation_id: CASCADE — log dies with the org.
--   • api_key_id: SET NULL — preserve the row when a key is deleted
--     so an org can audit "what did key X do in its lifetime"
--     via created_at + path even after revocation.
--
-- Forward-only, additive.
-- =============================================================================

-- --- Drizzle-generated schema (DO NOT HAND-EDIT this block) ------------------
CREATE TABLE "api_request_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"api_key_id" uuid,
	"method" text NOT NULL,
	"path" text NOT NULL,
	"status" integer NOT NULL,
	"latency_ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_request_log" ADD CONSTRAINT "api_request_log_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_request_log" ADD CONSTRAINT "api_request_log_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_request_log_org_created_idx" ON "api_request_log" USING btree ("organisation_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "api_request_log_created_at_idx" ON "api_request_log" USING btree ("created_at");--> statement-breakpoint

-- --- Value constraints -------------------------------------------------------
-- HTTP method whitelist. Defends against a path-bug somewhere
-- writing a non-method value.
ALTER TABLE "api_request_log"
  ADD CONSTRAINT "api_request_log_method_check"
  CHECK (method IN ('GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'HEAD', 'OPTIONS'));--> statement-breakpoint
-- Path bound. Real paths are <100 chars; the cap stops a
-- pathological client (or wrapper bug) from inflating storage.
ALTER TABLE "api_request_log"
  ADD CONSTRAINT "api_request_log_path_length_check"
  CHECK (length(path) BETWEEN 1 AND 500);--> statement-breakpoint
ALTER TABLE "api_request_log"
  ADD CONSTRAINT "api_request_log_status_range_check"
  CHECK (status BETWEEN 100 AND 599);--> statement-breakpoint
-- 5 minutes is a generous upper bound. Any longer than that and
-- something has broken — we want the row but flag it loudly.
ALTER TABLE "api_request_log"
  ADD CONSTRAINT "api_request_log_latency_range_check"
  CHECK (latency_ms BETWEEN 0 AND 300000);--> statement-breakpoint

-- --- Row Level Security ------------------------------------------------------
-- Deny-all from authenticated/anon. All reads/writes via adminDb.
-- Matches inbound_webhook_events (mig 0028) +
-- api_idempotency_keys (mig 0030).
ALTER TABLE "api_request_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "api_request_log_no_access" ON "api_request_log"
  FOR ALL TO authenticated, anon
  USING (false)
  WITH CHECK (false);
