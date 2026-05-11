-- =============================================================================
-- 0036: venue_sending_domains — per-venue verified sending identity
-- =============================================================================
--
-- Lets a Plus-tier operator register a domain they own + verify
-- ownership via Resend's DKIM/SPF/DMARC challenges. Once verified,
-- enquiry replies go out from `From: <slug>@<verified-domain>`
-- instead of the platform default, dropping the "via tablekit.uk"
-- Gmail suffix.
--
-- One row per venue (uniqueIndex). Remove + re-add is the only way to
-- switch domain — we don't keep history because the previous row's
-- resend_domain_id was already deleted in Resend at remove time.
--
-- RLS posture (matches venue_oauth_connections):
--   • SELECT: org members where venue_id is in user_visible_venue_ids()
--     so a per-venue scoped manager only sees their own venues.
--   • INSERT / UPDATE / DELETE: denied to authenticated. All mutations
--     flow through adminDb in server actions after requireRole gating.
--
-- Domain text + DNS records are NOT PII (DNS is public by design).
-- The resend_domain_id is an opaque vendor handle (UUID-shaped); also
-- non-PII.
-- =============================================================================

-- --- Drizzle-generated schema (DO NOT HAND-EDIT this block) ------------------
CREATE TABLE "venue_sending_domains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"venue_id" uuid NOT NULL,
	"domain" text NOT NULL,
	"resend_domain_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"dns_records" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verified_at" timestamp with time zone,
	"last_checked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "venue_sending_domains" ADD CONSTRAINT "venue_sending_domains_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "venue_sending_domains" ADD CONSTRAINT "venue_sending_domains_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "venue_sending_domains_venue_unique" ON "venue_sending_domains" USING btree ("venue_id");--> statement-breakpoint
CREATE INDEX "venue_sending_domains_org_idx" ON "venue_sending_domains" USING btree ("organisation_id");--> statement-breakpoint

-- --- Status enum-equivalent CHECK --------------------------------------------
-- Mirrors Resend's status values verbatim. A future Resend status we
-- haven't seen will fail this check loudly — better than silently
-- persisting an unknown state.
ALTER TABLE "venue_sending_domains"
  ADD CONSTRAINT "venue_sending_domains_status_check"
  CHECK (status IN ('not_started','pending','verified','failure','temporary_failure'));--> statement-breakpoint

-- Lowercase domain sanity. Operators may paste uppercase; the app
-- lowercases at insert. This defends against a future call site
-- skipping that step.
ALTER TABLE "venue_sending_domains"
  ADD CONSTRAINT "venue_sending_domains_domain_lower_check"
  CHECK (domain = lower(domain));--> statement-breakpoint

-- --- RLS ---------------------------------------------------------------------
ALTER TABLE "venue_sending_domains" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "venue_sending_domains" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- Members of the org with venue visibility can read their venue's
-- sending-domain row. No write policies — all mutations via adminDb
-- in server actions.
CREATE POLICY "venue_sending_domains_member_select"
  ON "venue_sending_domains"
  FOR SELECT TO authenticated
  USING (venue_id IN (SELECT public.user_visible_venue_ids()));--> statement-breakpoint
