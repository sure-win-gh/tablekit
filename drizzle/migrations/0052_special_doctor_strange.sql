CREATE TABLE "password_reset_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"initiated_by_admin_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "password_reset_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_initiated_by_admin_id_users_id_fk" FOREIGN KEY ("initiated_by_admin_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "password_reset_tokens_user_idx" ON "password_reset_tokens" USING btree ("user_id");--> statement-breakpoint
-- =============================================================================
-- RLS: deny-all (platform-level table, same posture as outreach_claims).
-- Every read/write goes through adminDb() from the reset server actions;
-- no authenticated/anon access. drizzle-kit does not emit RLS, so this
-- block is hand-added in the same migration (CLAUDE.md rule 3).
-- =============================================================================
ALTER TABLE "password_reset_tokens" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "password_reset_tokens" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "password_reset_tokens_no_access" ON "password_reset_tokens"
  FOR ALL TO authenticated, anon
  USING (false)
  WITH CHECK (false);