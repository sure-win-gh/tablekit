CREATE TABLE "platform_audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_email" "citext" NOT NULL,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "platform_audit_log_created_at_idx" ON "platform_audit_log" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint

-- --- RLS: platform_audit_log -------------------------------------------------
-- Platform-staff-only audit table. Operators must never read or write
-- this — RLS denies authenticated and anon outright. Writes flow via
-- adminDb() (Postgres BYPASSRLS attribute). The deny-all policy keeps
-- check-rls.ts happy: RLS enabled + at least one policy present.
ALTER TABLE "platform_audit_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "platform_audit_log_no_access" ON "platform_audit_log"
  FOR ALL TO authenticated, anon
  USING (false)
  WITH CHECK (false);