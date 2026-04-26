-- =============================================================================
-- 0011: dsar_requests — public privacy-request inbox
-- =============================================================================
--
-- Guest-facing form posts here via the public action; operators read
-- and action via /dashboard/privacy-requests. organisation_id is the
-- direct routing target (no parent table to denormalise from), so
-- there's no enforce_*_org_id trigger — the FK is the guard. RLS
-- restricts SELECT to org members; writes (insert from public form,
-- update from operator action) flow through adminDb().
--
-- Forward-only, additive. Drop in two releases if ever needed.
-- =============================================================================

-- --- Drizzle-generated schema (DO NOT HAND-EDIT this block) ------------------
CREATE TABLE "dsar_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"requester_email_hash" text NOT NULL,
	"requester_email_cipher" text NOT NULL,
	"message_cipher" text,
	"guest_id" uuid,
	"resolution_notes" text,
	"due_at" timestamp with time zone NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "dsar_requests" ADD CONSTRAINT "dsar_requests_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dsar_requests" ADD CONSTRAINT "dsar_requests_guest_id_guests_id_fk" FOREIGN KEY ("guest_id") REFERENCES "public"."guests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dsar_requests_org_idx" ON "dsar_requests" USING btree ("organisation_id");--> statement-breakpoint
CREATE INDEX "dsar_requests_active_idx" ON "dsar_requests" USING btree ("organisation_id","due_at") WHERE "dsar_requests"."status" in ('pending','in_progress');--> statement-breakpoint

-- --- Value constraints -------------------------------------------------------
-- Pin kind + status enums at the database level so a typo can't
-- silently drift the workflow. Email-hash format isn't constrained
-- here — `lib/security/crypto.ts` is the only writer.
ALTER TABLE "dsar_requests"
  ADD CONSTRAINT "dsar_requests_kind_check"
  CHECK (kind IN ('export', 'rectify', 'erase'));--> statement-breakpoint
ALTER TABLE "dsar_requests"
  ADD CONSTRAINT "dsar_requests_status_check"
  CHECK (status IN ('pending', 'in_progress', 'completed', 'rejected'));--> statement-breakpoint

-- --- updated_at touch trigger ------------------------------------------------
CREATE OR REPLACE FUNCTION public.touch_dsar_requests_updated_at()
  RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER touch_dsar_requests_updated_at
  BEFORE UPDATE ON public.dsar_requests
  FOR EACH ROW EXECUTE FUNCTION public.touch_dsar_requests_updated_at();
--> statement-breakpoint

-- --- Row Level Security ------------------------------------------------------
ALTER TABLE "dsar_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- Members of an organisation can read their requests. All writes
-- (public-form INSERT, operator-action UPDATE) flow through adminDb()
-- after manual org-scope check. No INSERT/UPDATE/DELETE policy for
-- the authenticated role — matches the messages + payments pattern.
CREATE POLICY "dsar_requests_member_read" ON "dsar_requests"
  FOR SELECT TO authenticated
  USING (organisation_id IN (SELECT public.user_organisation_ids()));
