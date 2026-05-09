-- =============================================================================
-- 0031: webhook_subscriptions — outbound webhook registrations (PR6a of public-api)
-- =============================================================================
--
-- Per-organisation outbound webhook endpoints. Plus customers
-- register an HTTPS URL + select which booking events to receive.
-- Each subscription has an envelope-encrypted shared secret used
-- to HMAC-SHA256 sign delivery bodies (PR6b ships the dispatcher).
--
-- RLS: SELECT for org members via public.user_organisation_ids() so
-- the dashboard list works under withUser. No INSERT/UPDATE/DELETE
-- policies — writes flow via adminDb after requireRole("owner") +
-- requirePlan(orgId, "plus") at the action layer. Same shape as
-- api_keys (mig 0029).
--
-- Forward-only, additive.
-- =============================================================================

-- --- Drizzle-generated schema (DO NOT HAND-EDIT this block) ------------------
CREATE TABLE "webhook_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"url" text NOT NULL,
	"label" text NOT NULL,
	"secret_cipher" text NOT NULL,
	"events" text[] NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by_user_id" uuid,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "webhook_subscriptions" ADD CONSTRAINT "webhook_subscriptions_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_subscriptions" ADD CONSTRAINT "webhook_subscriptions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "webhook_subscriptions_org_created_idx" ON "webhook_subscriptions" USING btree ("organisation_id","created_at" DESC NULLS LAST);--> statement-breakpoint

-- --- Value constraints -------------------------------------------------------
-- HTTPS-only URL. Plain http would let a network attacker forge or
-- read delivery bodies. The Zod check at the action layer is the
-- friendly version; this is the storage-level backstop.
ALTER TABLE "webhook_subscriptions"
  ADD CONSTRAINT "webhook_subscriptions_url_https_check"
  CHECK (url ~ '^https://' AND length(url) BETWEEN 12 AND 2048);--> statement-breakpoint
-- Operator-facing label. 1–80 chars, same shape as api_keys.label.
ALTER TABLE "webhook_subscriptions"
  ADD CONSTRAINT "webhook_subscriptions_label_length_check"
  CHECK (length(label) BETWEEN 1 AND 80);--> statement-breakpoint
-- At least one event subscribed. The dispatcher (PR6b) does the
-- enum-bounded check; here we just stop empty arrays sneaking in
-- via an action bug.
ALTER TABLE "webhook_subscriptions"
  ADD CONSTRAINT "webhook_subscriptions_events_nonempty_check"
  CHECK (cardinality(events) >= 1);--> statement-breakpoint

-- --- Row Level Security ------------------------------------------------------
ALTER TABLE "webhook_subscriptions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- Members of an organisation can read their own org's subscriptions
-- (so the dashboard list works under withUser). Writes (create,
-- revoke) flow via adminDb after explicit requireRole("owner") +
-- requirePlan checks at the action layer.
CREATE POLICY "webhook_subscriptions_member_read" ON "webhook_subscriptions"
  FOR SELECT TO authenticated
  USING (organisation_id IN (SELECT public.user_organisation_ids()));
