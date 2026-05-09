-- =============================================================================
-- 0029: api_keys — public REST API authentication (Plus tier, PR1/7)
-- =============================================================================
--
-- Bearer tokens for the public REST API at api.tablekit.uk/v1.
-- Format: `sk_live_<base64url(24 random bytes)>`. The plaintext is
-- shown to the operator exactly once at issuance — only the SHA-256
-- hash is persisted. The `prefix` column holds the first 12 chars
-- (`sk_live_xxxx`) for display in the dashboard.
--
-- Auth lookup at request time: hash the incoming Bearer token,
-- SELECT WHERE hash = ? AND revoked_at IS NULL. The unique index on
-- hash makes this O(log n).
--
-- RLS: SELECT for org members via public.user_organisation_ids() so
-- the dashboard list works under withUser. No INSERT/UPDATE/DELETE
-- policies — writes flow via adminDb after requireRole("owner") +
-- requirePlan(orgId, "plus"). Matches the api_keys pattern across
-- the codebase (enquiries, dsar_requests, messages, etc.).
--
-- Forward-only, additive.
-- =============================================================================

-- --- Drizzle-generated schema (DO NOT HAND-EDIT this block) ------------------
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"prefix" text NOT NULL,
	"hash" text NOT NULL,
	"label" text NOT NULL,
	"created_by_user_id" uuid,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_hash_unique" ON "api_keys" USING btree ("hash");--> statement-breakpoint
CREATE INDEX "api_keys_org_created_idx" ON "api_keys" USING btree ("organisation_id","created_at" DESC NULLS LAST);--> statement-breakpoint

-- --- Value constraints -------------------------------------------------------
-- Operator-facing label. 80 char cap is generous for "Production
-- billing pipeline" / "Mailchimp sync" etc. while bounding storage
-- per row.
ALTER TABLE "api_keys"
  ADD CONSTRAINT "api_keys_label_length_check"
  CHECK (length(label) BETWEEN 1 AND 80);--> statement-breakpoint
-- Prefix shape: literally `sk_live_` + 4 chars of the secret. 12
-- chars total, no surprises.
ALTER TABLE "api_keys"
  ADD CONSTRAINT "api_keys_prefix_shape_check"
  CHECK (prefix ~ '^sk_live_[A-Za-z0-9_-]{4}$');--> statement-breakpoint
-- Hash shape: SHA-256 hex (64 lowercase hex chars). Defends against
-- a bug that stores something else in this column — the auth lookup
-- relies on this being a deterministic hex hash.
ALTER TABLE "api_keys"
  ADD CONSTRAINT "api_keys_hash_shape_check"
  CHECK (hash ~ '^[0-9a-f]{64}$');--> statement-breakpoint

-- --- Row Level Security ------------------------------------------------------
ALTER TABLE "api_keys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- Members of an organisation can read their own org's keys (so the
-- dashboard list works under withUser). Writes (issue, revoke) flow
-- via adminDb after explicit requireRole("owner") + requirePlan
-- checks at the action layer.
CREATE POLICY "api_keys_member_read" ON "api_keys"
  FOR SELECT TO authenticated
  USING (organisation_id IN (SELECT public.user_organisation_ids()));
