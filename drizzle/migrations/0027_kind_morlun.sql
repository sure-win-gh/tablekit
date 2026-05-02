-- =============================================================================
-- 0027: enquiries — AI enquiry handler (Plus tier)
-- =============================================================================
--
-- One row per inbound email at `<venue-slug>@enquiries.tablekit.uk`.
-- Lifecycle: received → parsing → draft_ready → replied | failed |
-- discarded.
--
-- Body / subject / from-email / parsed-output / draft-reply are all
-- envelope-encrypted under the org's DEK (per gdpr.md §Encryption —
-- inbound email is fully untrusted and carries free-form PII).
-- `suggested_slots` is the only plaintext jsonb — slot times only,
-- no PII.
--
-- BEFORE INSERT OR UPDATE trigger denormalises organisation_id from
-- the parent venue (template: enforce_areas_org_id, mig 0001) so the
-- RLS check is one-hop. The trigger fires on UPDATE OF venue_id OR
-- organisation_id so a future code path that mutates org_id directly
-- can't drift away from the venue's true org.
--
-- RLS: SELECT for members via public.user_organisation_ids(). No
-- INSERT/UPDATE/DELETE policies — writes flow via adminDb (the
-- inbound webhook + the runner). Matches dsar_requests / messages /
-- import_jobs.
--
-- Forward-only, additive.
-- =============================================================================

-- --- Drizzle-generated schema (DO NOT HAND-EDIT this block) ------------------
CREATE TABLE "enquiries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"venue_id" uuid NOT NULL,
	"from_email_hash" text NOT NULL,
	"from_email_cipher" text NOT NULL,
	"subject_cipher" text NOT NULL,
	"body_cipher" text NOT NULL,
	"parsed_cipher" text,
	"suggested_slots" jsonb,
	"draft_reply_cipher" text,
	"status" text DEFAULT 'received' NOT NULL,
	"parse_attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"replied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "enquiries" ADD CONSTRAINT "enquiries_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enquiries" ADD CONSTRAINT "enquiries_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "enquiries_org_received_idx" ON "enquiries" USING btree ("organisation_id","received_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "enquiries_received_picker_idx" ON "enquiries" USING btree ("received_at") WHERE "enquiries"."status" = 'received';--> statement-breakpoint
CREATE INDEX "enquiries_org_email_hash_idx" ON "enquiries" USING btree ("organisation_id","from_email_hash");--> statement-breakpoint

-- --- Value constraints -------------------------------------------------------
ALTER TABLE "enquiries"
  ADD CONSTRAINT "enquiries_status_check"
  CHECK (status IN ('received', 'parsing', 'draft_ready', 'replied', 'failed', 'discarded'));--> statement-breakpoint
ALTER TABLE "enquiries"
  ADD CONSTRAINT "enquiries_parse_attempts_check"
  CHECK (parse_attempts >= 0);--> statement-breakpoint
-- Defence-in-depth length cap on `error`. Same shape as
-- import_jobs.error — Postgres / driver errors echo offending
-- input, so this column never exceeds 500 chars + the runner's
-- sanitiser passes everything through a regex scrubber first.
ALTER TABLE "enquiries"
  ADD CONSTRAINT "enquiries_error_length_check"
  CHECK ("error" IS NULL OR length("error") <= 500);--> statement-breakpoint

-- --- BEFORE INSERT trigger: denormalise organisation_id ----------------------
-- Mirrors enforce_areas_org_id (mig 0001). The webhook caller MUST
-- still pass organisation_id for Drizzle's notNull contract; this
-- trigger is the consistency backstop — it overrides whatever the
-- caller passed with the parent venue's organisation_id, so a
-- mismatched (org, venue) pair becomes the venue's true org. Fires
-- on UPDATE OF venue_id OR organisation_id so a code path that
-- changes either column can't drift the row out of the venue's org.
CREATE OR REPLACE FUNCTION public.enforce_enquiries_org_id()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
DECLARE
  v_org uuid;
BEGIN
  SELECT organisation_id INTO v_org FROM public.venues WHERE id = NEW.venue_id;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'enquiries: venue % does not exist', NEW.venue_id;
  END IF;
  NEW.organisation_id := v_org;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER enforce_enquiries_org_id
  BEFORE INSERT OR UPDATE OF venue_id, organisation_id ON public.enquiries
  FOR EACH ROW EXECUTE FUNCTION public.enforce_enquiries_org_id();
--> statement-breakpoint

-- --- updated_at touch trigger ------------------------------------------------
CREATE OR REPLACE FUNCTION public.touch_enquiries_updated_at()
  RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER touch_enquiries_updated_at
  BEFORE UPDATE ON public.enquiries
  FOR EACH ROW EXECUTE FUNCTION public.touch_enquiries_updated_at();
--> statement-breakpoint

-- --- Row Level Security ------------------------------------------------------
ALTER TABLE "enquiries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- Members of an organisation can read their own org's enquiries.
-- Writes (inbound webhook INSERT, runner UPDATE, operator-action
-- UPDATE) flow via adminDb after explicit org-scope checks.
CREATE POLICY "enquiries_member_read" ON "enquiries"
  FOR SELECT TO authenticated
  USING (organisation_id IN (SELECT public.user_organisation_ids()));
