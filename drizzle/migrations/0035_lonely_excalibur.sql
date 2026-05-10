-- =============================================================================
-- 0035: org_invitations — pending team invitations + accept tokens
-- =============================================================================
--
-- Owners invite teammates by email. We mint an opaque random token,
-- email a URL containing the plaintext, and store only its SHA-256
-- hash here — a DB leak yields no live URLs. State machine:
--
--   pending  : accepted_at IS NULL AND revoked_at IS NULL
--   accepted : accepted_at IS NOT NULL  (one-shot — token can't be reused)
--   revoked  : revoked_at IS NOT NULL   (owner cancelled)
--
-- Expiry (expires_at < now) makes a row dead without an UPDATE; the
-- accept handler refuses such rows.
--
-- RLS posture:
--   • SELECT: org members read invitations for their org (so a manager
--     can see who's pending without elevation). The pattern mirrors
--     audit_log.
--   • INSERT / UPDATE / DELETE: denied to authenticated. All writes
--     flow through adminDb() in the server action layer after explicit
--     role gating (createInvite is owner-only, revokeInvite is
--     owner-only). Belt + braces — RLS guarantees no privilege
--     escalation even if a server action skips its role gate.
--
-- A partial unique index keeps duplicate live invites at bay:
-- (organisation_id, email) is unique only for non-terminal rows. So an
-- owner can re-invite the same email after revoking, and an accepted
-- row never blocks a future fresh invite (e.g. if the user later
-- leaves the org).
-- =============================================================================

-- --- Drizzle-generated schema (DO NOT HAND-EDIT this block) ------------------
CREATE TABLE "org_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"email" "citext" NOT NULL,
	"role" "org_role" NOT NULL,
	"token_hash" text NOT NULL,
	"invited_by_user_id" uuid,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_invitations_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "org_invitations" ADD CONSTRAINT "org_invitations_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_invitations" ADD CONSTRAINT "org_invitations_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "org_invitations_org_created_idx" ON "org_invitations" USING btree ("organisation_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "org_invitations_email_idx" ON "org_invitations" USING btree ("email");--> statement-breakpoint

-- --- State-machine constraints -----------------------------------------------
-- Accepted and revoked are mutually exclusive — once a row hits either
-- terminal state it can't slide into the other.
ALTER TABLE "org_invitations"
  ADD CONSTRAINT "org_invitations_state_check"
  CHECK (NOT (accepted_at IS NOT NULL AND revoked_at IS NOT NULL));--> statement-breakpoint
-- Expiry must be in the future of creation (sanity — caught by app
-- code too, but a misconfigured clock or bad migration shouldn't
-- silently produce expires_at < created_at rows).
ALTER TABLE "org_invitations"
  ADD CONSTRAINT "org_invitations_expiry_check"
  CHECK (expires_at > created_at);--> statement-breakpoint

-- --- Live-invite uniqueness --------------------------------------------------
-- One pending invite per (org, email). Re-invite after revoke / accept
-- is allowed because terminal rows are excluded.
CREATE UNIQUE INDEX "org_invitations_pending_unique"
  ON "org_invitations" ("organisation_id", "email")
  WHERE accepted_at IS NULL AND revoked_at IS NULL;--> statement-breakpoint

-- --- RLS ---------------------------------------------------------------------
ALTER TABLE "org_invitations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "org_invitations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- Members of the org can read invitations for their org. No write
-- policies — all mutations flow through adminDb() in server actions.
CREATE POLICY "org_invitations_member_select"
  ON "org_invitations"
  FOR SELECT TO authenticated
  USING (organisation_id IN (SELECT public.user_organisation_ids()));--> statement-breakpoint
